import { describe, expect, it } from "vitest";

import {
  clientFor,
  expectApiError,
  expectOk,
  oneUser,
  raw,
  seedAccount,
  seedCategory,
  seedDebt,
  seedDebtPayment,
  seedTransaction,
  seedUser,
  tokenFor,
  twoUsers,
} from "../../test/api";
import { testApp } from "../../test/app";
import { MIXED_CURRENCIES_MESSAGE, UNKNOWN_CURRENCY_MESSAGE } from "./currency";

describe("reports", () => {
  it("summarises a month in the base currency, with transactions in their account currency", async () => {
    const { app, alice, aliceAccount, asAlice } = await twoUsers();
    const food = await seedCategory(alice);
    await asAlice.transactions.create({ type: "income", amount: { amountMinor: 10_000, currency: "USD" }, accountId: aliceAccount, date: "2026-04-01" });
    await asAlice.transactions.create({ type: "expense", amount: { amountMinor: 3_000, currency: "USD" }, accountId: aliceAccount, categoryId: food, date: "2026-04-02" });
    await asAlice.transactions.create({ type: "expense", amount: { amountMinor: 500, currency: "USD" }, accountId: aliceAccount, date: "2026-04-30" });
    await asAlice.transactions.create({ type: "expense", amount: { amountMinor: 999, currency: "USD" }, accountId: aliceAccount, date: "2026-03-31" });
    const token = await tokenFor(alice);

    const summary = expectOk(await raw(app, "reports.transactionSummary", { month: "2026-04" }, { token }));
    expect(summary).toMatchObject({
      month: "2026-04",
      totalIncome: { amountMinor: 10_000, currency: "USD" },
      totalExpenses: { amountMinor: 3_500, currency: "USD" },
      totalAdjustments: { amountMinor: 0, currency: "USD" },
    });
    expect((summary as { recentTransactions: Array<{ date: string }> }).recentTransactions.map((t) => t.date)).toEqual([
      "2026-04-30",
      "2026-04-02",
      "2026-04-01",
    ]);

    const spending = expectOk(await raw(app, "reports.spendingByCategory", { month: "2026-04" }, { token }));
    expect(spending).toEqual({
      month: "2026-04",
      total: { amountMinor: 3_500, currency: "USD" },
      categories: [
        { categoryId: food, name: "Food", amount: { amountMinor: 3_000, currency: "USD" } },
        { categoryId: null, name: "Uncategorized", amount: { amountMinor: 500, currency: "USD" } },
      ],
    });
  });

  it("returns cashflow trend months as YYYY-MM, oldest first, across a year boundary", async () => {
    const { app, alice, aliceAccount, asAlice } = await twoUsers();
    await asAlice.transactions.create({ type: "income", amount: { amountMinor: 700, currency: "USD" }, accountId: aliceAccount, date: "2025-12-31" });
    await asAlice.transactions.create({ type: "expense", amount: { amountMinor: 50, currency: "USD" }, accountId: aliceAccount, date: "2026-02-28" });
    const token = await tokenFor(alice);
    const flow = expectOk(await raw(app, "reports.cashflow", { month: "2026-02", trendMonths: 4 }, { token })) as {
      trend: Array<{ month: string; income: { amountMinor: number } }>;
      currentMonth: unknown;
    };
    expect(flow.trend.map((p) => p.month)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(flow.trend[1]?.income.amountMinor).toBe(700);
    expect(flow.currentMonth).toEqual({
      income: { amountMinor: 0, currency: "USD" },
      expenses: { amountMinor: 50, currency: "USD" },
      net: { amountMinor: -50, currency: "USD" },
    });
    const defaults = await clientFor(app, token).reports.cashflow({ month: "2026-02" });
    expect(defaults.trend).toHaveLength(6);
  });

  it("reports net worth and debt summary in the base currency, not accounts[0] or USD", async () => {
    const { app, user } = await oneUser({ baseCurrency: "JPY" });
    await seedAccount(user, { currency: "JPY", balance: 1_000_000 });
    await seedDebt(user, { originalAmount: 50_000, currentBalance: 20_000 });
    const token = await tokenFor(user);
    const worth = expectOk(await raw(app, "reports.netWorth", undefined, { token }));
    expect(worth).toEqual({
      hasData: true,
      totalAssets: { amountMinor: 10_000, currency: "JPY" },
      totalDebts: { amountMinor: 200, currency: "JPY" },
      netWorth: { amountMinor: 9_800, currency: "JPY" },
    });
    const debts = expectOk(await raw(app, "reports.debtSummary", undefined, { token }));
    expect(debts).toMatchObject({
      totalOriginal: { amountMinor: 500, currency: "JPY" },
      totalRemaining: { amountMinor: 200, currency: "JPY" },
      recentPayment: { amountMinor: 0, currency: "JPY" },
      debts: [{ name: "Loan", creditor: "Unknown lender", percentPaid: 60 }],
    });
  });

  it("clamps percentPaid to 0..100", async () => {
    const { user, client } = await oneUser();
    await seedDebt(user, { name: "Grown", originalAmount: 1_000, currentBalance: 1_500 });
    await seedDebt(user, { name: "Overpaid", originalAmount: 1_000, currentBalance: -100 });
    const { debts } = await client.reports.debtSummary();
    expect(debts.map((d) => [d.name, d.percentPaid])).toEqual([
      ["Grown", 0],
      ["Overpaid", 100],
    ]);
  });

  it("answers conflict, not a 500, for a total past the safe integer range", async () => {
    const { user, client } = await oneUser();
    for (const name of ["A", "B"]) {
      const accountId = await seedAccount(user, { name });
      await client.transactions.create({ type: "income", amount: { amountMinor: 5e15, currency: "USD" }, accountId, date: "2026-01-01" });
    }
    const error = await expectApiError(client.reports.transactionSummary({ month: "2026-01" }), "conflict", 409);
    expect(error.message).toBe("Amount out of range");
    await expectApiError(client.reports.netWorth(), "conflict", 409);
  });

  it("needs a profile: conflict before onboarding", async () => {
    const { client } = await oneUser({ profile: false });
    await expectApiError(client.reports.netWorth(), "conflict", 409);
    await expectApiError(client.reports.transactionSummary({ month: "2026-01" }), "conflict", 409);
  });

  describe("mixed currencies", () => {
    const MIXED = { reason: "mixed_currencies", currencies: ["EUR", "USD"] };

    async function mixedUser() {
      const { app } = testApp();
      const user = await seedUser(); // base USD
      const usd = await seedAccount(user, { balance: 10_000 });
      const eur = await seedAccount(user, { currency: "EUR", name: "Euro", balance: 5_000 });
      return { app, user, usd, eur, client: clientFor(app, await tokenFor(user)) };
    }

    it("returns conflict with the currency list instead of an unconverted total", async () => {
      const { app, user, eur, client } = await mixedUser();
      const token = await tokenFor(user);
      await client.transactions.create({ type: "expense", amount: { amountMinor: 100, currency: "EUR" }, accountId: eur, date: "2026-04-02" });

      for (const [path, input] of [
        ["reports.netWorth", undefined],
        ["reports.transactionSummary", { month: "2026-04" }],
        ["reports.spendingByCategory", { month: "2026-04" }],
        ["reports.cashflow", { month: "2026-05", trendMonths: 2 }],
      ] as const) {
        const response = await raw(app, path, input, { token });
        expect(response.status, path).toBe(409);
        expect(response.body.error).toEqual({ code: "conflict", message: MIXED_CURRENCIES_MESSAGE, details: MIXED });
      }
      // The same months without EUR rows are single-currency and still work.
      expect((await client.reports.transactionSummary({ month: "2026-03" })).totalExpenses).toEqual({ amountMinor: 0, currency: "USD" });
      expect((await client.reports.cashflow({ month: "2026-03", trendMonths: 1 })).trend).toHaveLength(1);
      expect((await client.reports.cashflow({ month: "2026-05", trendMonths: 1 })).trend).toHaveLength(1);
    });

    it("ignores non-base accounts that don't feed the report", async () => {
      const { user, usd, eur, client } = await mixedUser();
      await client.transactions.create({ type: "income", amount: { amountMinor: 700, currency: "USD" }, accountId: usd, date: "2026-04-02" });
      // Transfers are excluded from every total, so EUR transfer legs don't make a report mixed.
      const eur2 = await seedAccount(user, { currency: "EUR", name: "Euro 2" });
      await client.transfers.create({ amount: { amountMinor: 50, currency: "EUR" }, fromAccountId: eur, toAccountId: eur2, date: "2026-04-03" });
      const summary = await client.reports.transactionSummary({ month: "2026-04" });
      expect(summary.totalIncome).toEqual({ amountMinor: 700, currency: "USD" });
      // Transfer legs are listed in their own currency.
      expect(summary.recentTransactions.filter((t) => t.type === "transfer").map((t) => t.amount.currency)).toEqual(["EUR", "EUR"]);
      const spending = await client.reports.spendingByCategory({ month: "2026-04" });
      expect(spending.total).toEqual({ amountMinor: 0, currency: "USD" });
    });

    it("net worth: a non-base liability account is not summed, a non-base asset is", async () => {
      const { user, client } = await oneUser();
      await seedAccount(user, { balance: 1_000 });
      await seedAccount(user, { currency: "EUR", type: "credit_card", balance: -300 });
      expect((await client.reports.netWorth()).totalAssets).toEqual({ amountMinor: 1_000, currency: "USD" });
      await seedAccount(user, { currency: "EUR", balance: 1, archived: true });
      expect((await client.reports.netWorth()).netWorth.amountMinor).toBe(1_000);
      await seedAccount(user, { currency: "EUR", balance: 1 });
      const error = await expectApiError(client.reports.netWorth(), "conflict", 409);
      expect(error.details).toEqual(MIXED);
    });

    it("returns conflict when a summed row belongs to a deleted account", async () => {
      const { user, client } = await mixedUser();
      await seedTransaction(user, null, { amount: 100, date: "2026-04-02" });
      for (const call of [
        () => client.reports.transactionSummary({ month: "2026-04" }),
        () => client.reports.spendingByCategory({ month: "2026-04" }),
        () => client.reports.cashflow({ month: "2026-04", trendMonths: 1 }),
      ]) {
        const error = await expectApiError(call(), "conflict", 409);
        expect(error.message).toBe(UNKNOWN_CURRENCY_MESSAGE);
        expect(error.details).toEqual({ reason: "unknown_currency" });
      }
    });

    it("debt summary: conflict when the recent payment left a non-base account or one that is gone", async () => {
      const { user, usd, eur, client } = await mixedUser();
      const debtId = await seedDebt(user, { originalAmount: 50_000, currentBalance: 20_000 });
      expect((await client.reports.debtSummary()).totalRemaining).toEqual({ amountMinor: 20_000, currency: "USD" });
      await seedDebtPayment(user, { debtId, amount: 100, fromAccountId: usd });
      expect((await client.reports.debtSummary()).recentPayment).toEqual({ amountMinor: 100, currency: "USD" });
      await seedDebtPayment(user, { debtId, amount: 100, fromAccountId: eur });
      expect((await expectApiError(client.reports.debtSummary(), "conflict")).details).toEqual(MIXED);
      await seedDebtPayment(user, { debtId, amount: 100, fromAccountId: null });
      expect((await expectApiError(client.reports.debtSummary(), "conflict")).details).toEqual({ reason: "unknown_currency" });
    });
  });

  it("isolates users and validates months", async () => {
    const { aliceAccount, asAlice, asBob } = await twoUsers();
    await asAlice.transactions.create({ type: "income", amount: { amountMinor: 100, currency: "USD" }, accountId: aliceAccount, date: "2026-04-01" });
    const bob = await asBob.reports.transactionSummary({ month: "2026-04" });
    expect(bob.totalIncome.amountMinor).toBe(0);
    expect(bob.recentTransactions).toEqual([]);
    expect((await asBob.reports.netWorth()).totalAssets.amountMinor).toBe(50_000);
    await expectApiError(asAlice.reports.cashflow({ month: "2026-4" }), "validation_failed");
    await expectApiError(asAlice.reports.cashflow({ month: "2026-04", trendMonths: 25 }), "validation_failed");
  });
});
