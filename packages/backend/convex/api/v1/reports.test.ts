import { routes } from "@mpf/finance-contract";
import { describe, expect, it } from "vitest";

import { clientFor, expectApiError, expectConforms, raw, seedAccount, seedCategory, seedUser, setupApi, tokenFor, twoUsers } from "./test.helpers";

describe("api/v1 reports", () => {
  it("summarises a month in the base currency, with transactions in their account currency", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    const food = await seedCategory(t, alice);
    await asAlice.transactions.create({ type: "income", amount: { amountMinor: 10_000, currency: "USD" }, accountId: aliceAccount, date: "2026-04-01" });
    await asAlice.transactions.create({ type: "expense", amount: { amountMinor: 3_000, currency: "USD" }, accountId: aliceAccount, categoryId: food, date: "2026-04-02" });
    await asAlice.transactions.create({ type: "expense", amount: { amountMinor: 500, currency: "USD" }, accountId: aliceAccount, date: "2026-04-03" });
    await asAlice.transactions.create({ type: "expense", amount: { amountMinor: 999, currency: "USD" }, accountId: aliceAccount, date: "2026-03-30" });
    const token = await tokenFor(alice);

    const summary = expectConforms(routes.reports.transactionSummary, await raw(t, "GET", "/reports/transaction-summary?month=2026-04", { token }));
    expect(summary).toMatchObject({
      month: "2026-04",
      totalIncome: { amountMinor: 10_000, currency: "USD" },
      totalExpenses: { amountMinor: 3_500, currency: "USD" },
      totalAdjustments: { amountMinor: 0, currency: "USD" },
    });
    expect((summary as { recentTransactions: unknown[] }).recentTransactions).toHaveLength(3);

    const spending = expectConforms(routes.reports.spendingByCategory, await raw(t, "GET", "/reports/spending-by-category?month=2026-04", { token }));
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
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    await asAlice.transactions.create({ type: "income", amount: { amountMinor: 700, currency: "USD" }, accountId: aliceAccount, date: "2025-12-15" });
    const token = await tokenFor(alice);
    const flow = expectConforms(routes.reports.cashflow, await raw(t, "GET", "/reports/cashflow?month=2026-02&trendMonths=4", { token })) as {
      trend: Array<{ month: string; income: { amountMinor: number } }>;
      currentMonth: unknown;
    };
    expect(flow.trend.map((p) => p.month)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(flow.trend[1]?.income.amountMinor).toBe(700);
    expect(flow.currentMonth).toEqual({
      income: { amountMinor: 0, currency: "USD" },
      expenses: { amountMinor: 0, currency: "USD" },
      net: { amountMinor: 0, currency: "USD" },
    });
    const defaults = await clientFor(t, token).reports.cashflow({ month: "2026-02" });
    expect(defaults.trend).toHaveLength(6);
  });

  it("reports net worth and debt summary in the base currency, not accounts[0] or USD", async () => {
    const t = setupApi();
    const user = await seedUser(t, { baseCurrency: "JPY" });
    await seedAccount(t, user, { currency: "JPY", balance: 1_000_000 });
    await t.run((ctx) =>
      ctx.db.insert("debts", { userId: user, name: "Loan", debtType: "loan", originalAmount: 50_000, currentBalance: 20_000, createdAt: "2026-01-01" }),
    );
    const token = await tokenFor(user);
    const worth = expectConforms(routes.reports.netWorth, await raw(t, "GET", "/reports/net-worth", { token }));
    expect(worth).toEqual({
      hasData: true,
      totalAssets: { amountMinor: 10_000, currency: "JPY" },
      totalDebts: { amountMinor: 200, currency: "JPY" },
      netWorth: { amountMinor: 9_800, currency: "JPY" },
    });
    const debts = expectConforms(routes.reports.debtSummary, await raw(t, "GET", "/reports/debt-summary", { token }));
    expect(debts).toMatchObject({
      totalOriginal: { amountMinor: 500, currency: "JPY" },
      totalRemaining: { amountMinor: 200, currency: "JPY" },
      recentPayment: { amountMinor: 0, currency: "JPY" },
      debts: [{ name: "Loan", creditor: "Unknown lender", percentPaid: 60 }],
    });
  });

  it("isolates users and validates months", async () => {
    const t = setupApi();
    const { aliceAccount, asAlice, asBob } = await twoUsers(t);
    await asAlice.transactions.create({ type: "income", amount: { amountMinor: 100, currency: "USD" }, accountId: aliceAccount, date: "2026-04-01" });
    const bob = await asBob.reports.transactionSummary({ month: "2026-04" });
    expect(bob.totalIncome.amountMinor).toBe(0);
    expect(bob.recentTransactions).toEqual([]);
    expect((await asBob.reports.netWorth()).totalAssets.amountMinor).toBe(50_000);
    await expectApiError(asAlice.reports.cashflow({ month: "2026-4" }), "validation_failed");
    await expectApiError(asAlice.reports.cashflow({ month: "2026-04", trendMonths: 25 }), "validation_failed");
  });
});
