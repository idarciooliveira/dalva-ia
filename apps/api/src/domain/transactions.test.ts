import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  balanceOf,
  domainRejection,
  getTransactionRow,
  seedAccount,
  seedCategory,
  seedContribution,
  seedDebt,
  seedDebtPayment,
  seedSubcategory,
  seedTransaction,
} from "../../test/api";
import { createTestUser } from "../../test/app";
import { testDb } from "../../test/db";
import { readTx, type Tx, withTx } from "../db/tx";
import { MANAGED_MESSAGES } from "./ledger";
import * as transactions from "./transactions";
import type { TransactionManagedBy } from "./transactions";
import * as transfers from "./transfers";

const tx = <T>(fn: (tx: Tx) => Promise<T>) => withTx(testDb(), fn);
const read = <T>(fn: (tx: Tx) => Promise<T>) => readTx(testDb(), fn);


async function users() {
  const alice = await createTestUser();
  const bob = await createTestUser();
  return { alice, bob };
}

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

const create = (userId: string, args: Partial<Omit<transactions.TransactionFields, "amount">> & { accountId: string; amount?: number }) =>
  tx((t) => transactions.createTransaction(t, userId, { type: "expense", date: "2026-03-10", ...args, amount: usd(args.amount ?? 100) }));

describe("domain/transactions", () => {
  it("creates income/expense transactions and updates balances", async () => {
    const { alice } = await users();
    const accountId = await seedAccount(alice, { balance: 10_000 });
    const categoryId = await seedCategory(alice);

    const expense = await create(alice, { type: "expense", amount: 1_500, accountId, categoryId, description: "Lunch" });
    await create(alice, { type: "income", amount: 5_000, accountId, date: "2026-03-11" });

    expect(await balanceOf(accountId)).toBe(10_000 - 1_500 + 5_000);
    expect(await getTransactionRow(expense.id)).toMatchObject({
      userId: alice,
      type: "expense",
      amount: 1_500,
      categoryId,
      description: "Lunch",
      date: "2026-03-10",
    });
  });

  it("rejects categories/subcategories on adjustments (create and update)", async () => {
    const { alice } = await users();
    const accountId = await seedAccount(alice, { balance: 10_000 });
    const categoryId = await seedCategory(alice);
    const subcategoryId = await seedSubcategory(alice, categoryId);

    expect(await domainRejection(create(alice, { type: "adjustment", accountId, categoryId }))).toMatchObject({
      code: "validation_failed",
      message: "Adjustments cannot have a category",
    });
    expect(await domainRejection(create(alice, { type: "adjustment", accountId, subcategoryId }))).toMatchObject({
      message: "Adjustments cannot have a subcategory",
    });
    const expense = await create(alice, { accountId, categoryId });
    expect(await domainRejection(tx((t) => transactions.updateTransaction(t, alice, expense.id, { type: "adjustment" })))).toMatchObject({
      message: "Adjustments cannot have a category",
    });
    expect(await balanceOf(accountId)).toBe(9_900);
  });

  it("requires the subcategory to sit under the row's category", async () => {
    const { alice } = await users();
    const accountId = await seedAccount(alice);
    const food = await seedCategory(alice);
    const transport = await seedCategory(alice, { name: "Transport" });
    const groceries = await seedSubcategory(alice, food, "Groceries");

    expect(await domainRejection(create(alice, { accountId, categoryId: transport, subcategoryId: groceries }))).toMatchObject({
      code: "validation_failed",
    });
    expect(await domainRejection(create(alice, { accountId, subcategoryId: groceries }))).toMatchObject({ code: "validation_failed" });
    const row = await create(alice, { accountId, categoryId: food });
    // The current category counts when the update names no category.
    const updated = await tx((t) => transactions.updateTransaction(t, alice, row.id, { subcategoryId: groceries }));
    expect(updated).toMatchObject({ categoryId: food, subcategoryId: groceries });
    // A new category without a subcategory drops the old one; the same category keeps it.
    const kept = await tx((t) => transactions.updateTransaction(t, alice, row.id, { categoryId: food, note: "same" }));
    expect(kept.subcategoryId).toBe(groceries);
    const moved = await tx((t) => transactions.updateTransaction(t, alice, row.id, { categoryId: transport }));
    expect(moved).toMatchObject({ categoryId: transport, subcategoryId: null });
  });

  it("update and delete move the row through the ledger", async () => {
    const { alice } = await users();
    const first = await seedAccount(alice, { balance: 10_000 });
    const second = await seedAccount(alice, { balance: 2_000 });
    const row = await create(alice, { amount: 1_000, accountId: first });
    await tx((t) => transactions.updateTransaction(t, alice, row.id, { type: "income", amount: usd(400), accountId: second, note: "moved" }));
    expect([await balanceOf(first), await balanceOf(second)]).toEqual([10_000, 2_400]);
    expect(await getTransactionRow(row.id)).toMatchObject({ type: "income", amount: 400, accountId: second, note: "moved" });

    await tx((t) => transactions.deleteTransaction(t, alice, row.id));
    expect(await balanceOf(second)).toBe(2_000);
    expect(await getTransactionRow(row.id)).toBeUndefined();
  });

  it("refuses the transfer type on create and update", async () => {
    const { alice } = await users();
    const accountId = await seedAccount(alice, { balance: 10_000 });
    const asTransfer = { type: "transfer" } as unknown as { type: "income" };
    expect(await domainRejection(create(alice, { ...asTransfer, accountId }))).toMatchObject({
      message: "Use the transfer create for transfers",
    });
    const row = await create(alice, { accountId });
    expect(await domainRejection(tx((t) => transactions.updateTransaction(t, alice, row.id, asTransfer)))).toMatchObject({
      message: "Use the transfer create for transfers",
    });
    expect(await balanceOf(accountId)).toBe(9_900);
  });

  it("refuses to update or delete rows a transfer, goal or debt manages, and labels them", async () => {
    const { alice } = await users();
    const from = await seedAccount(alice, { balance: 10_000 });
    const to = await seedAccount(alice);
    const loan = await seedAccount(alice, { type: "loan" });
    const outgoing = await tx((t) => transfers.createTransfer(t, alice, { amount: usd(2_000), fromAccountId: from, toAccountId: to, date: "2026-01-01" }));
    const saved = await tx((t) => transfers.createTransfer(t, alice, { amount: usd(500), fromAccountId: from, toAccountId: to, date: "2026-01-02" }));
    await seedContribution(alice, saved, to);
    const payment = await seedDebtPayment(alice, { debtId: await seedDebt(alice, { linkedAccountId: loan }), fromAccountId: from, liabilityAccountId: loan });
    const plain = await seedTransaction(alice, from);

    const managed: Array<[string, TransactionManagedBy]> = [
      [outgoing, "transfer"],
      [(await getTransactionRow(outgoing))!.linkedTransactionId!, "transfer"],
      [saved, "goal_contribution"],
      [(await getTransactionRow(saved))!.linkedTransactionId!, "goal_contribution"],
      [payment.sourceTransactionId, "debt_payment"],
      [payment.liabilityTransactionId!, "debt_payment"],
    ];
    for (const [id, owner] of managed) {
      const refusal = { code: "conflict", message: MANAGED_MESSAGES[owner] };
      expect(await domainRejection(tx((t) => transactions.deleteTransaction(t, alice, id))), id).toEqual(refusal);
      expect(await domainRejection(tx((t) => transactions.updateTransaction(t, alice, id, { note: "x" }))), id).toEqual(refusal);
    }
    const rows = await Promise.all([...managed.map(([id]) => id), plain].map(async (id) => (await getTransactionRow(id))!));
    expect(Object.fromEntries(await read((t) => transactions.managedBy(t, alice, rows)))).toEqual(Object.fromEntries(managed));
    expect([await balanceOf(from), await balanceOf(to)]).toEqual([7_500, 2_500]);
  });

  describe("cross-user ownership", () => {
    it("rejects foreign account, category and subcategory references on create", async () => {
      const { alice, bob } = await users();
      const aliceAccount = await seedAccount(alice, { balance: 10_000 });
      const bobAccount = await seedAccount(bob);
      const bobCategory = await seedCategory(bob);
      const bobSub = await seedSubcategory(bob, bobCategory);

      expect(await domainRejection(create(alice, { accountId: bobAccount }))).toEqual({ code: "not_found", message: "Account not found" });
      expect(await domainRejection(create(alice, { accountId: aliceAccount, categoryId: bobCategory }))).toEqual({
        code: "not_found",
        message: "Category not found",
      });
      expect(await domainRejection(create(alice, { accountId: aliceAccount, subcategoryId: bobSub }))).toEqual({
        code: "not_found",
        message: "Subcategory not found",
      });
      expect(await balanceOf(aliceAccount)).toBe(10_000);
    });

    it("rejects update/delete of another user's transaction and moving it to a foreign account", async () => {
      const { alice, bob } = await users();
      const aliceAccount = await seedAccount(alice, { balance: 10_000 });
      const bobAccount = await seedAccount(bob, { balance: 10_000 });
      const row = await create(alice, { accountId: aliceAccount });

      expect(await domainRejection(tx((t) => transactions.updateTransaction(t, bob, row.id, { amount: usd(1) })))).toEqual({
        code: "not_found",
        message: "Transaction not found",
      });
      expect(await domainRejection(tx((t) => transactions.deleteTransaction(t, bob, row.id)))).toMatchObject({ code: "not_found" });
      expect(await domainRejection(tx((t) => transactions.updateTransaction(t, alice, row.id, { accountId: bobAccount })))).toEqual({
        code: "not_found",
        message: "Account not found",
      });
      expect(await balanceOf(aliceAccount)).toBe(9_900);
      expect(await balanceOf(bobAccount)).toBe(10_000);
    });
  });

  describe("search", () => {
    it("filters by type, account, category, date range and q, newest first, per user", async () => {
      const { alice, bob } = await users();
      const accountId = await seedAccount(alice);
      const other = await seedAccount(alice, { name: "Other" });
      const food = await seedCategory(alice);
      const jan = await seedTransaction(alice, accountId, { type: "income", date: "2026-01-01", payee: "ACME 100%" });
      const feb = await seedTransaction(alice, accountId, { date: "2026-02-01", categoryId: food, note: "Coffee beans" });
      const mar = await seedTransaction(alice, other, { date: "2026-03-01", description: "morning coffee" });
      await seedTransaction(bob, await seedAccount(bob), { date: "2026-03-02", description: "coffee" });
      const ids = async (args: Omit<Parameters<typeof transactions.searchTransactions>[2], "limit">) =>
        (await read((t) => transactions.searchTransactions(t, alice, { limit: 10, ...args }))).items.map((r) => r.id);

      expect(await ids({})).toEqual([mar, feb, jan]);
      expect(await ids({ type: "expense", dateFrom: "2026-02-01" })).toEqual([mar, feb]);
      expect(await ids({ dateTo: "2026-02-01" })).toEqual([feb, jan]);
      expect(await ids({ accountId })).toEqual([feb, jan]);
      expect(await ids({ categoryId: food })).toEqual([feb]);
      expect(await ids({ q: "COFFEE" })).toEqual([mar, feb]);
      // LIKE metacharacters in q match themselves, not any character(s).
      expect(await ids({ q: "%" })).toEqual([jan]);
      expect(await ids({ q: "10_" })).toEqual([]);
      expect(await ids({ q: "Coffee_beans" })).toEqual([]);
    });

    it("pages rows created in one transaction (same created_at) without gaps or repeats, with every limit", async () => {
      const { alice } = await users();
      const accountId = await seedAccount(alice);
      const ids = await tx(async (t) => {
        const out: string[] = [];
        for (let i = 0; i < 9; i++) {
          out.push((await transactions.createTransaction(t, alice, { type: "expense", amount: usd(i + 1), accountId, date: i < 6 ? "2026-05-01" : "2026-04-01" })).id);
        }
        return out;
      });
      // Newest first: the later date, then the later insert.
      const expected = [...ids.slice(0, 6).reverse(), ...ids.slice(6).reverse()];
      for (const limit of [1, 2, 3, 4, 9, 10]) {
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await read((t) => transactions.searchTransactions(t, alice, { limit, cursor }));
          // Every page but the last is full.
          if (page.nextCursor) expect(page.items).toHaveLength(limit);
          seen.push(...page.items.map((r) => r.id));
          cursor = page.nextCursor ?? undefined;
          expect(++pages).toBeLessThan(20);
        } while (cursor);
        expect(seen, `limit ${limit}`).toEqual(expected);
      }
    });

    it("tells rows created within one millisecond apart", async () => {
      const { alice } = await users();
      const accountId = await seedAccount(alice);
      const ids: string[] = [];
      for (const micros of ["001", "002", "003"]) {
        const id = await seedTransaction(alice, accountId, { date: "2026-01-01" });
        // A JS Date can't hold microseconds: set them in SQL.
        await testDb().execute(sql`update transactions set created_at = ${`2026-01-01 00:00:00.123${micros}+00`}::timestamptz where id = ${id}`);
        ids.push(id);
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await read((t) => transactions.searchTransactions(t, alice, { limit: 1, cursor }));
        seen.push(...page.items.map((r) => r.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual([...ids].reverse());
    });

    it("rejects malformed cursors", () => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const id = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
      for (const bad of [
        "",
        "!!",
        encode([]),
        encode(["2026-01-01", "1"]),
        encode(["2026-02-30", "1", id]),
        encode(["2026-01-01", "1.5", id]),
        encode(["2026-01-01", 1, id]),
        encode(["2026-01-01", "1", "nope"]),
        encode(["2026-01-01", "1", id.toUpperCase()]),
      ]) {
        expect(() => transactions.decodeSearchCursor(bad), bad).toThrow("Invalid cursor");
      }
      const position = { date: "2026-01-01", createdAtMicros: "1767225600123456", id };
      expect(transactions.decodeSearchCursor(transactions.encodeSearchCursor(position))).toEqual(position);
    });
  });
});
