import { routes } from "@mpf/finance-contract";
import { describe, expect, it } from "vitest";

import {
  balanceOf,
  clientFor,
  expectApiError,
  expectConforms,
  getTransactionRow,
  oneUser,
  raw,
  seedAccount,
  seedCategory,
  seedContribution,
  seedDebt,
  seedDebtPayment,
  seedSubcategory,
  seedTransaction,
  seedUser,
  tokenFor,
  transactionRows,
  twoUsers,
} from "../../../test/api";
import { testApp } from "../../../test/app";
import { MISSING_ACCOUNT_ID } from "./shared";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

describe("api/v1 transactions: writes", () => {
  it("creates income, expense and adjustment rows and returns the entity", async () => {
    const { asAlice, alice, aliceAccount } = await twoUsers();
    const categoryId = await seedCategory(alice);

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
    expect(await balanceOf(aliceAccount)).toBe(100_000 - 1_250 + 5_000 - 250);
  });

  it("converts 0-decimal input amounts to the x100 storage", async () => {
    const { user, client } = await oneUser({ baseCurrency: "JPY" });
    const jpy = await seedAccount(user, { currency: "JPY" });
    const { transaction } = await client.transactions.create({ type: "income", amount: { amountMinor: 1500, currency: "JPY" }, accountId: jpy, date: "2026-01-01" });
    expect(transaction.amount).toEqual({ amountMinor: 1500, currency: "JPY" });
    expect((await getTransactionRow(transaction.id))?.amount).toBe(150_000);
  });

  it("rejects type transfer, the wrong sign, a currency mismatch and foreign/malformed references", async () => {
    const { app, alice, bob, aliceAccount, asAlice } = await twoUsers();
    const transfer = await raw(app, "POST", "/transactions", {
      token: await tokenFor(alice),
      idempotencyKey: "tx-transfer-0001",
      body: { type: "transfer", amount: usd(1), accountId: aliceAccount, date: "2026-01-01" },
    });
    expect(transfer.status).toBe(400);

    const base = { amount: usd(100), accountId: aliceAccount, date: "2026-01-01" } as const;
    await expectApiError(asAlice.transactions.create({ ...base, type: "expense", amount: usd(-100) }), "validation_failed");
    await expectApiError(asAlice.transactions.create({ ...base, type: "income", amount: { amountMinor: 100, currency: "EUR" } }), "validation_failed");
    await expectApiError(asAlice.transactions.create({ ...base, type: "expense", categoryId: "nope" }), "validation_failed");
    await expectApiError(asAlice.transactions.create({ ...base, type: "expense", categoryId: await seedCategory(bob) }), "not_found");
    await expectApiError(asAlice.transactions.create({ ...base, accountId: "nope", type: "expense" }), "validation_failed");
    const aliceCategory = await seedCategory(alice);
    const sub = await seedSubcategory(alice, await seedCategory(alice, { name: "Other" }));
    await expectApiError(asAlice.transactions.create({ ...base, type: "expense", categoryId: aliceCategory, subcategoryId: sub }), "validation_failed");
    expect(await balanceOf(aliceAccount)).toBe(100_000);
    expect(await transactionRows()).toEqual([]);
  });

  it("updates with the sign rule enforced against the effective type", async () => {
    const { aliceAccount, asAlice } = await twoUsers();
    const adjustment = await asAlice.transactions.create({ type: "adjustment", amount: usd(-300), accountId: aliceAccount, date: "2026-03-01" });

    // Turning a negative adjustment into an expense without a new amount breaks the sign rule.
    await expectApiError(asAlice.transactions.update({ id: adjustment.transaction.id, type: "expense" }), "validation_failed");
    // Without a type change the schema can't know; the server checks the stored type.
    const expense = await asAlice.transactions.create({ type: "expense", amount: usd(500), accountId: aliceAccount, date: "2026-03-01" });
    await expectApiError(asAlice.transactions.update({ id: expense.transaction.id, amount: usd(-5) }), "validation_failed");

    const { transaction } = await asAlice.transactions.update({ id: adjustment.transaction.id, type: "expense", amount: usd(300), payee: "Shop" });
    expect(transaction).toMatchObject({ type: "expense", amount: usd(300), payee: "Shop" });
    expect(await balanceOf(aliceAccount)).toBe(100_000 - 300 - 500);
    const negative = await asAlice.transactions.update({ id: expense.transaction.id, type: "adjustment", amount: usd(-50) });
    expect(negative.transaction.amount).toEqual(usd(-50));
    expect(await balanceOf(aliceAccount)).toBe(100_000 - 300 - 50);
  });

  it("requires a new amount to move a row to an account in another currency", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const eur = await seedAccount(alice, { currency: "EUR" });
    const { transaction: row } = await asAlice.transactions.create({ type: "expense", amount: usd(100), accountId: aliceAccount, date: "2026-03-01" });
    await expectApiError(asAlice.transactions.update({ id: row.id, accountId: eur }), "validation_failed");
    await expectApiError(asAlice.transactions.update({ id: row.id, accountId: eur, amount: usd(100) }), "validation_failed");
    const { transaction } = await asAlice.transactions.update({ id: row.id, accountId: eur, amount: { amountMinor: 90, currency: "EUR" } });
    expect(transaction).toMatchObject({ accountId: eur, amount: { amountMinor: 90, currency: "EUR" } });
    expect(await balanceOf(aliceAccount)).toBe(100_000);
    expect(await balanceOf(eur)).toBe(-90);
  });

  it("rejects 3-decimal amounts the storage can't hold exactly (precision), on every write", async () => {
    const { user, client } = await oneUser({ baseCurrency: "KWD" });
    const kwd = await seedAccount(user, { currency: "KWD" });
    const kwd2 = await seedAccount(user, { currency: "KWD", name: "Second" });
    const odd = { amountMinor: 12_345, currency: "KWD" }; // 12.345 would be stored as 12.35
    const precision = async (promise: Promise<unknown>) => {
      const error = await expectApiError(promise, "validation_failed", 400);
      expect(error.details).toMatchObject({ reason: "precision" });
    };
    await precision(client.transactions.create({ type: "expense", amount: odd, accountId: kwd, date: "2026-01-01" }));
    await precision(client.accounts.adjust({ id: kwd, amount: odd }));
    await precision(client.transfers.create({ amount: odd, fromAccountId: kwd, toAccountId: kwd2, date: "2026-01-01" }));
    const { transaction } = await client.transactions.create({ type: "expense", amount: { amountMinor: 12_340, currency: "KWD" }, accountId: kwd, date: "2026-01-01" });
    expect(transaction.amount).toEqual({ amountMinor: 12_340, currency: "KWD" });
    await precision(client.transactions.update({ id: transaction.id, amount: odd }));
    expect(await transactionRows()).toHaveLength(1);
  });

  it("rejects amounts that round to zero in storage (3-decimal currencies)", async () => {
    const { user, client } = await oneUser({ baseCurrency: "KWD" });
    const kwd = await seedAccount(user, { currency: "KWD" });
    const kwd2 = await seedAccount(user, { currency: "KWD", name: "Second" });
    await expectApiError(client.transactions.create({ type: "expense", amount: { amountMinor: 4, currency: "KWD" }, accountId: kwd, date: "2026-01-01" }), "validation_failed");
    await expectApiError(client.accounts.adjust({ id: kwd, amount: { amountMinor: -4, currency: "KWD" } }), "validation_failed");
    const { transfer } = await client.transfers.create({ amount: { amountMinor: 10, currency: "KWD" }, fromAccountId: kwd, toAccountId: kwd2, date: "2026-01-01" });
    await expectApiError(client.transfers.update({ id: transfer.outgoingId, amount: { amountMinor: 3, currency: "KWD" } }), "validation_failed");
    await expectApiError(client.accounts.adjust({ id: kwd, amount: { amountMinor: 5, currency: "KWD" } }), "validation_failed");
  });

  it("refuses a balance the contract can't show in the currency's minor units (KWD x10), writing nothing", async () => {
    const { user, client } = await oneUser({ baseCurrency: "KWD" });
    const kwd = await seedAccount(user, { currency: "KWD" });
    const big = { amountMinor: 9e15, currency: "KWD" };
    await client.transactions.create({ type: "income", amount: big, accountId: kwd, date: "2026-01-01" });
    await expectApiError(client.transactions.create({ type: "income", amount: big, accountId: kwd, date: "2026-01-01" }), "validation_failed", 400);
    expect((await client.accounts.list()).items[0]?.balance).toEqual(big);
  });

  it("drops the old subcategory when only the category changes", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const food = await seedCategory(alice);
    const transport = await seedCategory(alice, { name: "Transport" });
    const groceries = await seedSubcategory(alice, food, "Groceries");
    const { transaction } = await asAlice.transactions.create({ type: "expense", amount: usd(100), accountId: aliceAccount, categoryId: food, subcategoryId: groceries, date: "2026-01-01" });
    const kept = await asAlice.transactions.update({ id: transaction.id, categoryId: food, note: "same" });
    expect(kept.transaction.subcategoryId).toBe(groceries);
    const moved = await asAlice.transactions.update({ id: transaction.id, categoryId: transport });
    expect(moved.transaction).toMatchObject({ categoryId: transport });
    expect(moved.transaction.subcategoryId).toBeUndefined();
  });

  it("deletes a plain row and restores the balance", async () => {
    const { aliceAccount, asAlice } = await twoUsers();
    const { transaction } = await asAlice.transactions.create({ type: "expense", amount: usd(700), accountId: aliceAccount, date: "2026-03-01" });
    expect(await asAlice.transactions.delete({ id: transaction.id })).toEqual({ id: transaction.id });
    expect(await balanceOf(aliceAccount)).toBe(100_000);
    await expectApiError(asAlice.transactions.delete({ id: transaction.id }), "not_found");
  });

  it("returns conflict for managed rows: transfer legs and debt-payment transactions", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const savings = await seedAccount(alice, { name: "Savings" });
    const { transfer } = await asAlice.transfers.create({ amount: usd(1_000), fromAccountId: aliceAccount, toAccountId: savings, date: "2026-01-01" });
    for (const id of [transfer.outgoingId, transfer.incomingId]) {
      await expectApiError(asAlice.transactions.update({ id, note: "x" }), "conflict", 409);
      await expectApiError(asAlice.transactions.delete({ id }), "conflict", 409);
    }

    const loan = await seedAccount(alice, { name: "Loan", type: "loan", balance: 10_000 });
    const debtId = await seedDebt(alice, { linkedAccountId: loan });
    const payment = await seedDebtPayment(alice, { debtId, fromAccountId: aliceAccount, liabilityAccountId: loan });
    for (const id of [payment.sourceTransactionId, payment.liabilityTransactionId!]) {
      await expectApiError(asAlice.transactions.update({ id, note: "x" }), "conflict");
      await expectApiError(asAlice.transactions.delete({ id }), "conflict");
    }
    expect(await balanceOf(aliceAccount)).toBe(99_000);
  });

  it("isolates users on update and delete", async () => {
    const { alice, aliceAccount, asBob, bobAccount } = await twoUsers();
    const id = await seedTransaction(alice, aliceAccount);
    await expectApiError(asBob.transactions.update({ id, note: "mine" }), "not_found", 404);
    await expectApiError(asBob.transactions.delete({ id }), "not_found", 404);
    const bobOwn = (await asBob.transactions.create({ type: "expense", amount: usd(1), accountId: bobAccount, date: "2026-01-01" })).transaction;
    await expectApiError(asBob.transactions.update({ id: bobOwn.id, accountId: aliceAccount }), "not_found");
    expect((await getTransactionRow(id))?.note).toBeNull();
    expect(await balanceOf(aliceAccount)).toBe(100_000);
  });

  it("handles legacy rows whose account is gone: listed in the base currency, deletable, movable", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const orphan = await seedTransaction(alice, null, { amount: 300 });
    const { transaction } = await asAlice.transactions.get({ id: orphan });
    expect(transaction).toMatchObject({ accountId: MISSING_ACCOUNT_ID, amount: usd(300) });
    await expectApiError(asAlice.accounts.get({ id: MISSING_ACCOUNT_ID }), "not_found");
    // Without an account to take the currency from, an update must move it.
    await expectApiError(asAlice.transactions.update({ id: orphan, note: "x" }), "not_found");
    const moved = await asAlice.transactions.update({ id: orphan, accountId: aliceAccount, note: "x" });
    expect(moved.transaction).toMatchObject({ accountId: aliceAccount, note: "x" });
    expect(await balanceOf(aliceAccount)).toBe(99_700);

    const other = await seedTransaction(alice, null, { amount: 50 });
    await asAlice.transactions.delete({ id: other });
    expect(await balanceOf(aliceAccount)).toBe(99_700);
  });
});

describe("api/v1 transactions: get", () => {
  it("returns one row with its currency and conforms to the contract", async () => {
    const { app, alice, aliceAccount, asAlice } = await twoUsers();
    const categoryId = await seedCategory(alice);
    const id = await seedTransaction(alice, aliceAccount, { amount: 1_250, categoryId, description: "Lunch", tags: ["a"] });
    const { transaction, managedBy } = await asAlice.transactions.get({ id });
    expect(transaction).toEqual({ id, type: "expense", amount: usd(1_250), accountId: aliceAccount, categoryId, date: "2026-03-01", description: "Lunch", tags: ["a"] });
    expect(managedBy).toBeUndefined();
    expectConforms(routes.transactions.get, await raw(app, "GET", `/transactions/${id}`, { token: await tokenFor(alice) }));
  });

  it("flags managed rows: transfer legs, goal-contribution transfers and debt payments", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const savings = await seedAccount(alice, { name: "Savings" });
    const { transfer } = await asAlice.transfers.create({ amount: usd(1_000), fromAccountId: aliceAccount, toAccountId: savings, date: "2026-01-01" });
    for (const id of [transfer.outgoingId, transfer.incomingId]) {
      expect((await asAlice.transactions.get({ id })).managedBy).toBe("transfer");
    }

    const goal = await asAlice.transfers.create({ amount: usd(500), fromAccountId: aliceAccount, toAccountId: savings, date: "2026-01-02" });
    await seedContribution(alice, goal.transfer.outgoingId, savings);
    for (const id of [goal.transfer.outgoingId, goal.transfer.incomingId]) {
      expect((await asAlice.transactions.get({ id })).managedBy).toBe("goal_contribution");
    }

    const payment = await seedDebtPayment(alice, { debtId: await seedDebt(alice), fromAccountId: aliceAccount });
    expect((await asAlice.transactions.get({ id: payment.sourceTransactionId })).managedBy).toBe("debt_payment");
  });

  it("isolates users and rejects malformed ids", async () => {
    const { alice, aliceAccount, asBob } = await twoUsers();
    const id = await seedTransaction(alice, aliceAccount);
    await expectApiError(asBob.transactions.get({ id }), "not_found", 404);
    await expectApiError(asBob.transactions.get({ id: "nope" }), "validation_failed", 400);
  });
});

describe("api/v1 transactions: search", () => {
  it("pages newest first with a real cursor and no gaps or repeats", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await seedTransaction(alice, aliceAccount, { date: `2026-03-0${(i % 3) + 1}`, amount: 100 + i }));

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
    // By date, newest first; within a date, the later insert first.
    const byDate = (d: number) => ids.filter((_, i) => i % 3 === d - 1).reverse();
    expect(seen).toEqual([...byDate(3), ...byDate(2), ...byDate(1)]);

    const exact = await asAlice.transactions.search({ limit: 7 });
    expect(exact.nextCursor).toBeNull();
  });

  it("filters by account, category, type and date range, and conforms to the contract", async () => {
    const { app, alice, aliceAccount } = await twoUsers();
    const other = await seedAccount(alice, { name: "Other", currency: "EUR" });
    const food = await seedCategory(alice);
    const a = await seedTransaction(alice, aliceAccount, { date: "2026-02-10", categoryId: food });
    const b = await seedTransaction(alice, aliceAccount, { date: "2026-03-10", type: "income" });
    const c = await seedTransaction(alice, other, { date: "2026-03-15", categoryId: food });
    const token = await tokenFor(alice);
    const search = async (query: string) =>
      expectConforms(routes.transactions.search, await raw(app, "GET", `/transactions?${query}`, { token })) as {
        items: Array<{ id: string; amount: unknown }>;
      };
    const ids = async (query: string) => (await search(query)).items.map((i) => i.id);

    expect(await ids(`accountId=${aliceAccount}`)).toEqual([b, a]);
    expect(await ids(`categoryId=${food}`)).toEqual([c, a]);
    expect(await ids("type=income")).toEqual([b]);
    expect(await ids("dateFrom=2026-03-01&dateTo=2026-03-12")).toEqual([b]);
    expect(await ids(`categoryId=${food}&accountId=${other}&dateFrom=2026-03-01`)).toEqual([c]);
    expect((await search(`accountId=${other}`)).items[0]?.amount).toEqual({ amountMinor: 100, currency: "EUR" });
  });

  it("matches q case-insensitively over description, note and payee", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const d = await seedTransaction(alice, aliceAccount, { description: "Morning COFFEE" });
    const n = await seedTransaction(alice, aliceAccount, { note: "coffee beans" });
    const p = await seedTransaction(alice, aliceAccount, { payee: "Coffee House" });
    await seedTransaction(alice, aliceAccount, { description: "Groceries" });
    const { items, nextCursor } = await asAlice.transactions.search({ q: "coffee" });
    expect(items.map((i) => i.id).sort()).toEqual([d, n, p].sort());
    expect(nextCursor).toBeNull();
  });

  it("returns full pages under a sparse q: the next page starts right after the last match", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const old = await seedTransaction(alice, aliceAccount, { date: "2026-01-01", payee: "needle" });
    for (let i = 0; i < 5; i++) await seedTransaction(alice, aliceAccount, { date: "2026-02-01" });
    const recent = await seedTransaction(alice, aliceAccount, { date: "2026-03-01", payee: "Needle" });
    const first = await asAlice.transactions.search({ q: "needle", limit: 1 });
    expect(first.items.map((i) => i.id)).toEqual([recent]);
    const second = await asAlice.transactions.search({ q: "needle", limit: 1, cursor: first.nextCursor! });
    expect(second).toMatchObject({ items: [{ id: old }], nextCursor: null });
  });

  it("flags managed rows on the page as transactions.get does", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const savings = await seedAccount(alice, { name: "Savings" });
    const plain = await seedTransaction(alice, aliceAccount, { date: "2026-01-05" });
    const { transfer } = await asAlice.transfers.create({ amount: usd(1_000), fromAccountId: aliceAccount, toAccountId: savings, date: "2026-01-01" });
    const goal = await asAlice.transfers.create({ amount: usd(500), fromAccountId: aliceAccount, toAccountId: savings, date: "2026-01-02" });
    await seedContribution(alice, goal.transfer.outgoingId, savings);
    const payment = await seedDebtPayment(alice, { debtId: await seedDebt(alice), fromAccountId: aliceAccount, liabilityAccountId: savings });

    const { items } = await asAlice.transactions.search({ limit: 100 });
    const flags = Object.fromEntries(items.map((t) => [t.id, t.managedBy]));
    expect(flags).toEqual({
      [plain]: undefined,
      [transfer.outgoingId]: "transfer",
      [transfer.incomingId]: "transfer",
      [goal.transfer.outgoingId]: "goal_contribution",
      [goal.transfer.incomingId]: "goal_contribution",
      [payment.sourceTransactionId]: "debt_payment",
      [payment.liabilityTransactionId!]: "debt_payment",
    });
    expect(items.find((t) => t.id === plain)).not.toHaveProperty("managedBy");
  });

  it("rejects a malformed cursor and isolates users", async () => {
    const { alice, aliceAccount, asAlice, asBob } = await twoUsers();
    await seedTransaction(alice, aliceAccount);
    await expectApiError(asAlice.transactions.search({ cursor: "garbage!" }), "validation_failed");
    await expectApiError(asAlice.transactions.search({ cursor: btoa("[1,2]") }), "validation_failed");
    expect((await asBob.transactions.search()).items).toEqual([]);
    await expectApiError(asBob.transactions.search({ accountId: aliceAccount }), "not_found", 404);
    await expectApiError(asBob.transactions.search({ categoryId: await seedCategory(alice) }), "not_found", 404);
  });

  it("labels legacy rows without an account with the base currency", async () => {
    const user = await seedUser({ baseCurrency: "EUR" });
    const client = clientFor(testApp().app, await tokenFor(user));
    await seedTransaction(user, null, { amount: 300 });
    expect((await client.transactions.search()).items).toEqual([
      expect.objectContaining({ accountId: MISSING_ACCOUNT_ID, amount: { amountMinor: 300, currency: "EUR" } }),
    ]);
  });
});

describe("api/v1 transactions: concurrency", () => {
  it("keeps one account's balance exact under parallel creates, updates and deletes", async () => {
    const { aliceAccount, asAlice } = await twoUsers();
    const created = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        asAlice.transactions.create({ type: i % 3 === 0 ? "income" : "expense", amount: usd(100 + i), accountId: aliceAccount, date: "2026-03-01" }),
      ),
    );
    const signed = (type: string, amount: number) => (type === "income" ? amount : -amount);
    const expected = 100_000 + created.reduce((sum, { transaction: t }) => sum + signed(t.type, t.amount.amountMinor), 0);
    expect(await balanceOf(aliceAccount)).toBe(expected);

    // Half deleted, half doubled, all at once.
    await Promise.all(
      created.map(({ transaction: t }, i) =>
        i % 2 === 0 ? asAlice.transactions.delete({ id: t.id }) : asAlice.transactions.update({ id: t.id, amount: usd(t.amount.amountMinor * 2) }),
      ),
    );
    const remaining = created.filter((_, i) => i % 2 === 1).map(({ transaction: t }) => signed(t.type, t.amount.amountMinor * 2));
    expect(await balanceOf(aliceAccount)).toBe(100_000 + remaining.reduce((a, b) => a + b, 0));
    expect(await transactionRows()).toHaveLength(6);
  });
});
