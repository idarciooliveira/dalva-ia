import { routes } from "@mpf/finance-contract";
import { describe, expect, it } from "vitest";

import type { Id } from "../../_generated/dataModel";
import * as debtPaymentsDomain from "../../domain/debtPayments";
import * as transactionsDomain from "../../domain/transactions";
import {
  clientFor,
  expectApiError,
  expectConforms,
  getDoc,
  raw,
  seedAccount,
  seedCategory,
  seedUser,
  setupApi,
  tokenFor,
  twoUsers,
  type T,
} from "./test.helpers";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

async function seedTx(
  t: T,
  userId: string,
  accountId: Id<"accounts">,
  fields: Partial<{ type: "income" | "expense" | "adjustment"; amount: number; date: string; description: string; note: string; payee: string; categoryId: Id<"categories"> }> = {},
) {
  return await t.run((ctx) =>
    transactionsDomain.createTransaction(ctx, userId, {
      type: fields.type ?? "expense",
      amount: fields.amount ?? 100,
      accountId,
      date: fields.date ?? "2026-03-01",
      ...(fields.categoryId ? { categoryId: fields.categoryId } : {}),
      ...(fields.description ? { description: fields.description } : {}),
      ...(fields.note ? { note: fields.note } : {}),
      ...(fields.payee ? { payee: fields.payee } : {}),
    }),
  );
}

describe("api/v1 transactions: writes", () => {
  it("creates income, expense and adjustment rows and returns the entity", async () => {
    const t = setupApi();
    const { asAlice, alice, aliceAccount } = await twoUsers(t);
    const categoryId = await seedCategory(t, alice);

    const { transaction } = await asAlice.transactions.create({
      type: "expense",
      amount: usd(1_250),
      accountId: aliceAccount,
      categoryId,
      date: "2026-04-05",
      description: "Lunch",
      payee: "Cafe",
    });
    expect(transaction).toEqual({
      id: expect.any(String),
      type: "expense",
      amount: usd(1_250),
      accountId: aliceAccount,
      categoryId,
      date: "2026-04-05",
      description: "Lunch",
      payee: "Cafe",
    });
    await asAlice.transactions.create({ type: "income", amount: usd(5_000), accountId: aliceAccount, date: "2026-04-06" });
    await asAlice.transactions.create({ type: "adjustment", amount: usd(-250), accountId: aliceAccount, date: "2026-04-07" });
    expect((await getDoc(t, aliceAccount))?.balance).toBe(100_000 - 1_250 + 5_000 - 250);
  });

  it("converts 0-decimal input amounts to the app's x100 storage", async () => {
    const t = setupApi();
    const user = await seedUser(t, { baseCurrency: "JPY" });
    const jpy = await seedAccount(t, user, { currency: "JPY" });
    const client = clientFor(t, await tokenFor(user));
    const { transaction } = await client.transactions.create({ type: "income", amount: { amountMinor: 1500, currency: "JPY" }, accountId: jpy, date: "2026-01-01" });
    expect(transaction.amount).toEqual({ amountMinor: 1500, currency: "JPY" });
    expect((await getDoc(t, transaction.id as unknown as Id<"transactions">))?.amount).toBe(150_000);
  });

  it("rejects type transfer, the wrong sign, a currency mismatch and foreign/malformed references", async () => {
    const t = setupApi();
    const { alice, bob, aliceAccount, asAlice } = await twoUsers(t);
    const token = await tokenFor(alice);
    const transfer = await raw(t, "POST", "/transactions", {
      token,
      idempotencyKey: "tx-transfer-0001",
      body: { type: "transfer", amount: usd(1), accountId: aliceAccount, date: "2026-01-01" },
    });
    expect(transfer.status).toBe(400);

    const base = { amount: usd(100), accountId: aliceAccount, date: "2026-01-01" } as const;
    await expectApiError(asAlice.transactions.create({ ...base, type: "expense", amount: usd(-100) }), "validation_failed");
    await expectApiError(asAlice.transactions.create({ ...base, type: "income", amount: { amountMinor: 100, currency: "EUR" } }), "validation_failed");
    await expectApiError(asAlice.transactions.create({ ...base, type: "expense", categoryId: "nope" }), "validation_failed");
    const bobCategory = await seedCategory(t, bob);
    await expectApiError(asAlice.transactions.create({ ...base, type: "expense", categoryId: bobCategory }), "not_found");
    const aliceCategory = await seedCategory(t, alice);
    const otherCategory = await seedCategory(t, alice, { name: "Other" });
    const sub = await t.run((ctx) => ctx.db.insert("subcategories", { userId: alice, categoryId: otherCategory, name: "s", archived: false, sortOrder: 0 }));
    await expectApiError(
      asAlice.transactions.create({ ...base, type: "expense", categoryId: aliceCategory, subcategoryId: sub }),
      "validation_failed",
    );
    expect((await getDoc(t, aliceAccount))?.balance).toBe(100_000);
  });

  it("updates with the sign rule enforced against the effective type", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    const adjustment = await seedTx(t, alice, aliceAccount, { type: "adjustment", amount: -300 });

    // Turning a negative adjustment into an expense without a new amount breaks the sign rule.
    await expectApiError(asAlice.transactions.update({ id: adjustment, type: "expense" }), "validation_failed");
    // Without a type change the schema can't know; the server checks the stored type.
    const expense = await seedTx(t, alice, aliceAccount, { amount: 500 });
    await expectApiError(asAlice.transactions.update({ id: expense, amount: usd(-5) }), "validation_failed");

    const { transaction } = await asAlice.transactions.update({ id: adjustment, type: "expense", amount: usd(300), payee: "Shop" });
    expect(transaction).toMatchObject({ type: "expense", amount: usd(300), payee: "Shop" });
    expect((await getDoc(t, aliceAccount))?.balance).toBe(100_000 - 300 - 500);
    const negative = await asAlice.transactions.update({ id: expense, type: "adjustment", amount: usd(-50) });
    expect(negative.transaction.amount).toEqual(usd(-50));
  });

  it("requires a new amount to move a row to an account in another currency", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    const eur = await seedAccount(t, alice, { currency: "EUR" });
    const tx = await seedTx(t, alice, aliceAccount);
    await expectApiError(asAlice.transactions.update({ id: tx, accountId: eur }), "validation_failed");
    await expectApiError(asAlice.transactions.update({ id: tx, accountId: eur, amount: usd(100) }), "validation_failed");
    const { transaction } = await asAlice.transactions.update({ id: tx, accountId: eur, amount: { amountMinor: 90, currency: "EUR" } });
    expect(transaction.amount).toEqual({ amountMinor: 90, currency: "EUR" });
  });

  it("rejects amounts that round to zero in storage (3-decimal currencies)", async () => {
    const t = setupApi();
    const user = await seedUser(t, { baseCurrency: "KWD" });
    const kwd = await seedAccount(t, user, { currency: "KWD" });
    const kwd2 = await seedAccount(t, user, { currency: "KWD", name: "Second" });
    const client = clientFor(t, await tokenFor(user));
    const tiny = { amountMinor: 4, currency: "KWD" };
    await expectApiError(client.transactions.create({ type: "expense", amount: tiny, accountId: kwd, date: "2026-01-01" }), "validation_failed");
    await expectApiError(client.accounts.adjust({ id: kwd, amount: { amountMinor: -4, currency: "KWD" } }), "validation_failed");
    const { transfer } = await client.transfers.create({ amount: { amountMinor: 10, currency: "KWD" }, fromAccountId: kwd, toAccountId: kwd2, date: "2026-01-01" });
    await expectApiError(client.transfers.update({ id: transfer.outgoingId, amount: { amountMinor: 3, currency: "KWD" } }), "validation_failed");
    expect((await client.accounts.adjust({ id: kwd, amount: { amountMinor: 5, currency: "KWD" } })).account.balance).toEqual({ amountMinor: 0, currency: "KWD" });
  });

  it("drops the old subcategory when only the category changes", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    const food = await seedCategory(t, alice);
    const transport = await seedCategory(t, alice, { name: "Transport" });
    const groceries = await t.run((ctx) => ctx.db.insert("subcategories", { userId: alice, categoryId: food, name: "Groceries", archived: false, sortOrder: 0 }));
    const { transaction } = await asAlice.transactions.create({ type: "expense", amount: usd(100), accountId: aliceAccount, categoryId: food, subcategoryId: groceries, date: "2026-01-01" });
    const kept = await asAlice.transactions.update({ id: transaction.id, categoryId: food, note: "same" });
    expect(kept.transaction.subcategoryId).toBe(groceries);
    const moved = await asAlice.transactions.update({ id: transaction.id, categoryId: transport });
    expect(moved.transaction).toMatchObject({ categoryId: transport });
    expect(moved.transaction.subcategoryId).toBeUndefined();
  });

  it("deletes a plain row and restores the balance", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    const tx = await seedTx(t, alice, aliceAccount, { amount: 700 });
    expect(await asAlice.transactions.delete({ id: tx })).toEqual({ id: tx });
    expect((await getDoc(t, aliceAccount))?.balance).toBe(100_000);
    await expectApiError(asAlice.transactions.delete({ id: tx }), "not_found");
  });

  it("returns conflict for managed rows: transfer legs and debt-payment transactions", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    const savings = await seedAccount(t, alice, { name: "Savings" });
    const { transfer } = await asAlice.transfers.create({ amount: usd(1_000), fromAccountId: aliceAccount, toAccountId: savings, date: "2026-01-01" });
    for (const id of [transfer.outgoingId, transfer.incomingId]) {
      await expectApiError(asAlice.transactions.update({ id, note: "x" }), "conflict", 409);
      await expectApiError(asAlice.transactions.delete({ id }), "conflict", 409);
    }

    const loan = await seedAccount(t, alice, { name: "Loan", type: "loan", balance: 10_000 });
    const debtId = await t.run((ctx) =>
      ctx.db.insert("debts", { userId: alice, name: "Car", debtType: "loan", originalAmount: 10_000, currentBalance: 10_000, linkedAccountId: loan, createdAt: "2026-01-01" }),
    );
    const paymentId = await t.run((ctx) =>
      debtPaymentsDomain.recordDebtPayment(ctx, alice, { debtId, amount: 500, date: "2026-01-02", fromAccountId: aliceAccount }),
    );
    const payment = await t.run((ctx) => ctx.db.get(paymentId));
    for (const id of [payment!.sourceTransactionId, payment!.liabilityTransactionId!]) {
      await expectApiError(asAlice.transactions.update({ id, note: "x" }), "conflict");
      await expectApiError(asAlice.transactions.delete({ id }), "conflict");
    }
  });

  it("isolates users on update and delete", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asBob, bobAccount } = await twoUsers(t);
    const tx = await seedTx(t, alice, aliceAccount);
    await expectApiError(asBob.transactions.update({ id: tx, note: "mine" }), "not_found", 404);
    await expectApiError(asBob.transactions.delete({ id: tx }), "not_found", 404);
    const bobOwn = (await asBob.transactions.create({ type: "expense", amount: usd(1), accountId: bobAccount, date: "2026-01-01" })).transaction;
    await expectApiError(asBob.transactions.update({ id: bobOwn.id, accountId: aliceAccount }), "not_found");
    expect((await getDoc(t, tx))?.note).toBeUndefined();
  });
});

describe("api/v1 transactions: get", () => {
  it("returns one row with its currency and conforms to the contract", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    const categoryId = await seedCategory(t, alice);
    const id = await seedTx(t, alice, aliceAccount, { amount: 1_250, categoryId, description: "Lunch" });
    const { transaction, managedBy } = await asAlice.transactions.get({ id });
    expect(transaction).toMatchObject({ id, type: "expense", amount: usd(1_250), accountId: aliceAccount, categoryId, description: "Lunch" });
    expect(managedBy).toBeUndefined();
    expectConforms(routes.transactions.get, await raw(t, "GET", `/transactions/${id}`, { token: await tokenFor(alice) }));
  });

  it("flags managed rows: transfer legs, goal-contribution transfers and debt payments", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    const savings = await seedAccount(t, alice, { name: "Savings" });
    const { transfer } = await asAlice.transfers.create({ amount: usd(1_000), fromAccountId: aliceAccount, toAccountId: savings, date: "2026-01-01" });
    for (const id of [transfer.outgoingId, transfer.incomingId]) {
      expect((await asAlice.transactions.get({ id })).managedBy).toBe("transfer");
    }

    const goalId = await t.run((ctx) =>
      ctx.db.insert("savingsGoals", { userId: alice, name: "Trip", targetAmount: 10_000, currentAmount: 0, linkedAccountId: savings, isVirtual: false, createdAt: "2026-01-01" }),
    );
    const { contribution } = await asAlice.goalContributions.add({ goalId, amount: usd(500), date: "2026-01-02", fromAccountId: aliceAccount });
    expect((await asAlice.transactions.get({ id: contribution.transactionId! })).managedBy).toBe("goal_contribution");

    const loan = await seedAccount(t, alice, { name: "Loan", type: "loan", balance: 10_000 });
    const debtId = await t.run((ctx) =>
      ctx.db.insert("debts", { userId: alice, name: "Car", debtType: "loan", originalAmount: 10_000, currentBalance: 10_000, linkedAccountId: loan, createdAt: "2026-01-01" }),
    );
    const paymentId = await t.run((ctx) =>
      debtPaymentsDomain.recordDebtPayment(ctx, alice, { debtId, amount: 500, date: "2026-01-02", fromAccountId: aliceAccount }),
    );
    const payment = await t.run((ctx) => ctx.db.get(paymentId));
    expect((await asAlice.transactions.get({ id: payment!.sourceTransactionId })).managedBy).toBe("debt_payment");
  });

  it("isolates users and rejects malformed ids", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asBob } = await twoUsers(t);
    const id = await seedTx(t, alice, aliceAccount);
    await expectApiError(asBob.transactions.get({ id }), "not_found", 404);
    await expectApiError(asBob.transactions.get({ id: "nope" }), "validation_failed", 400);
  });
});

describe("api/v1 transactions: search", () => {
  it("pages newest first with a real cursor and no gaps or repeats", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await seedTx(t, alice, aliceAccount, { date: `2026-03-0${(i % 3) + 1}`, amount: 100 + i }));

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await asAlice.transactions.search({ limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    const rows = await t.run((ctx) => Promise.all(seen.map((id) => ctx.db.get(id as Id<"transactions">))));
    const order = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
      a!.date === b!.date ? b!._creationTime - a!._creationTime : a!.date < b!.date ? 1 : -1;
    expect(rows).toEqual([...rows].sort(order));

    const exact = await asAlice.transactions.search({ limit: 7 });
    expect(exact.nextCursor).toBeNull();
  });

  it("pages through rows inserted in one mutation with every limit", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    // One mutation: on a real deployment these rows can share a _creationTime
    // (convex-test makes it unique, so this guards the ordering, not the tie path).
    const ids = await t.run(async (ctx) => {
      const out: string[] = [];
      for (let i = 0; i < 9; i++) {
        out.push(await ctx.db.insert("transactions", { userId: alice, type: "expense", amount: i + 1, accountId: aliceAccount, date: i < 6 ? "2026-05-01" : "2026-04-01" }));
      }
      return out;
    });
    for (const limit of [1, 2, 3, 4]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await asAlice.transactions.search({ limit, ...(cursor ? { cursor } : {}) });
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen.sort()).toEqual([...ids].sort());
    }
  });

  it("filters by account, category, type and date range, and conforms to the contract", async () => {
    const t = setupApi();
    const { alice, aliceAccount } = await twoUsers(t);
    const other = await seedAccount(t, alice, { name: "Other", currency: "EUR" });
    const food = await seedCategory(t, alice);
    const a = await seedTx(t, alice, aliceAccount, { date: "2026-02-10", categoryId: food });
    const b = await seedTx(t, alice, aliceAccount, { date: "2026-03-10", type: "income" });
    const c = await seedTx(t, alice, other, { date: "2026-03-15", categoryId: food });
    const token = await tokenFor(alice);
    const ids = async (query: string) =>
      (expectConforms(routes.transactions.search, await raw(t, "GET", `/transactions?${query}`, { token })) as { items: Array<{ id: string }> }).items.map(
        (i) => i.id,
      );

    expect(await ids(`accountId=${aliceAccount}`)).toEqual([b, a]);
    expect(await ids(`categoryId=${food}`)).toEqual([c, a]);
    expect(await ids("type=income")).toEqual([b]);
    expect(await ids("dateFrom=2026-03-01&dateTo=2026-03-12")).toEqual([b]);
    expect(await ids(`categoryId=${food}&accountId=${other}&dateFrom=2026-03-01`)).toEqual([c]);
    const eurRow = await raw(t, "GET", `/transactions?accountId=${other}`, { token });
    expect((eurRow.body.data as { items: Array<{ amount: unknown }> }).items[0]?.amount).toEqual({ amountMinor: 100, currency: "EUR" });
  });

  it("matches q case-insensitively over description, note and payee", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    const d = await seedTx(t, alice, aliceAccount, { description: "Morning COFFEE" });
    const n = await seedTx(t, alice, aliceAccount, { note: "coffee beans" });
    const p = await seedTx(t, alice, aliceAccount, { payee: "Coffee House" });
    await seedTx(t, alice, aliceAccount, { description: "Groceries" });
    const { items, nextCursor } = await asAlice.transactions.search({ q: "coffee" });
    expect(items.map((i) => i.id).sort()).toEqual([d, n, p].sort());
    expect(nextCursor).toBeNull();
  });

  it("bounds each page by a scan limit and resumes from the last row read", async () => {
    const t = setupApi();
    const { alice, aliceAccount } = await twoUsers(t);
    const match = await seedTx(t, alice, aliceAccount, { date: "2026-01-01", payee: "needle" });
    for (let i = 0; i < 5; i++) await seedTx(t, alice, aliceAccount, { date: "2026-02-01" });

    const first = await t.run((ctx) => transactionsDomain.searchTransactions(ctx, alice, { q: "needle", limit: 10, scanLimit: 3 }));
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    const second = await t.run((ctx) =>
      transactionsDomain.searchTransactions(ctx, alice, { q: "needle", limit: 10, scanLimit: 3, cursor: first.nextCursor! }),
    );
    expect(second.items.map((i) => i._id)).toEqual([match]);
    expect(second.nextCursor).toBeNull();
  });

  it("rejects a malformed cursor and isolates users", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice, asBob } = await twoUsers(t);
    await seedTx(t, alice, aliceAccount);
    await expectApiError(asAlice.transactions.search({ cursor: "garbage!" }), "validation_failed");
    await expectApiError(asAlice.transactions.search({ cursor: btoa("[1,2]") }), "validation_failed");
    expect((await asBob.transactions.search()).items).toEqual([]);
    await expectApiError(asBob.transactions.search({ accountId: aliceAccount }), "not_found", 404);
  });
});
