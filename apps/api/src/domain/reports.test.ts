import { describe, expect, it } from "vitest";

import { seedAccount, seedCategory, seedDebt, seedDebtPayment, seedTransaction } from "../../test/api";
import { createTestUser } from "../../test/app";
import { testDb } from "../../test/db";
import { transactions } from "../db/schema";
import { readTx, type Tx, withTx } from "../db/tx";
import * as reports from "./reports";
import * as transfers from "./transfers";

const read = <T>(fn: (tx: Tx) => Promise<T>) => readTx(testDb(), fn);

describe("domain/reports", () => {
  it("computes summary, spending by category and cashflow for a user", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const accountId = await seedAccount(alice);
    const food = await seedCategory(alice, { name: "Food" });
    await seedTransaction(alice, accountId, { type: "income", amount: 9_000, date: "2026-03-05" });
    await seedTransaction(alice, accountId, { amount: 2_000, date: "2026-03-06", categoryId: food });
    await seedTransaction(alice, accountId, { amount: 500, date: "2026-03-31" });
    await seedTransaction(alice, accountId, { type: "adjustment", amount: -300, date: "2026-03-07" });
    await seedTransaction(alice, accountId, { amount: 700, date: "2026-02-28" });
    await seedTransaction(alice, accountId, { amount: 999, date: "2026-04-01" });
    // Transfers count in no total.
    const savings = await seedAccount(alice, { name: "Savings" });
    await withTx(testDb(), (t) => transfers.createTransfer(t, alice, { amount: 5_000, fromAccountId: accountId, toAccountId: savings, date: "2026-03-08" }));

    const summary = await read((t) => reports.transactionSummary(t, alice, "2026-03"));
    expect(summary).toMatchObject({ totalIncome: 9_000, totalExpenses: 2_500, totalAdjustments: -300 });
    // Newest first, transfer legs included.
    expect(summary.recentTransactions.map((r) => r.date)).toEqual(["2026-03-31", "2026-03-08", "2026-03-08", "2026-03-07", "2026-03-06", "2026-03-05"]);

    const spending = await read((t) => reports.spendingByCategory(t, alice, "2026-03"));
    expect(spending).toEqual({
      total: 2_500,
      categories: [
        { name: "Food", amount: 2_000, categoryId: food },
        { name: "Uncategorized", amount: 500, categoryId: null },
      ],
    });

    const cashflow = await read((t) => reports.cashflow(t, alice, "2026-03", 2));
    expect(cashflow).toEqual({
      currentMonth: { income: 9_000, expenses: 2_500, net: 6_500 },
      trend: [
        { month: "2026-02", income: 0, expenses: 700 },
        { month: "2026-03", income: 9_000, expenses: 2_500 },
      ],
    });

    // Another user sees none of it.
    expect(await read((t) => reports.transactionSummary(t, bob, "2026-03"))).toEqual({
      totalIncome: 0,
      totalExpenses: 0,
      totalAdjustments: 0,
      recentTransactions: [],
    });
    expect(await read((t) => reports.spendingByCategory(t, bob, "2026-03"))).toEqual({ total: 0, categories: [] });
  });

  it("orders tied categories by their first expense of the month, as Convex", async () => {
    const alice = await createTestUser();
    const accountId = await seedAccount(alice);
    const zed = await seedCategory(alice, { name: "Zed" });
    const abe = await seedCategory(alice, { name: "Abe" });
    await seedTransaction(alice, accountId, { amount: 100, date: "2026-03-02", categoryId: zed });
    await seedTransaction(alice, accountId, { amount: 100, date: "2026-03-05", categoryId: abe });
    await seedTransaction(alice, accountId, { amount: 100, date: "2026-03-09" });
    const { categories } = await read((t) => reports.spendingByCategory(t, alice, "2026-03"));
    expect(categories.map((c) => c.name)).toEqual(["Zed", "Abe", "Uncategorized"]);
  });

  it("uses each month's real last day: February, leap years, December", async () => {
    const alice = await createTestUser();
    const accountId = await seedAccount(alice);
    for (const date of ["2026-02-28", "2026-03-01", "2024-02-29", "2025-12-31", "2026-01-01"]) {
      await seedTransaction(alice, accountId, { type: "income", amount: 1, date });
    }
    const income = async (month: string) => (await read((t) => reports.transactionSummary(t, alice, month))).totalIncome;
    expect(await income("2026-02")).toBe(1);
    expect(await income("2024-02")).toBe(1);
    expect(await income("2025-12")).toBe(1);
    const flow = await read((t) => reports.cashflow(t, alice, "2026-03", 4));
    expect(flow.trend.map((p) => [p.month, p.income])).toEqual([
      ["2025-12", 1],
      ["2026-01", 1],
      ["2026-02", 1],
      ["2026-03", 1],
    ]);
  });

  it("refuses months whose range would start before year 1", async () => {
    const alice = await createTestUser();
    await expect(read((t) => reports.cashflow(t, alice, "0001-03", 6))).rejects.toThrow("Month out of range");
    await expect(read((t) => reports.transactionSummary(t, alice, "0000-12"))).rejects.toThrow("Month out of range");
    expect((await read((t) => reports.cashflow(t, alice, "0001-03", 3))).trend.map((p) => p.month)).toEqual(["0001-01", "0001-02", "0001-03"]);
  });

  it("totals every row of the month, past what Convex read", async () => {
    const alice = await createTestUser();
    const accountId = await seedAccount(alice);
    await testDb()
      .insert(transactions)
      .values(Array.from({ length: 600 }, () => ({ userId: alice, accountId, type: "expense" as const, amount: 1, date: "2026-03-15" })));
    expect((await read((t) => reports.transactionSummary(t, alice, "2026-03"))).totalExpenses).toBe(600);
    expect((await read((t) => reports.spendingByCategory(t, alice, "2026-03"))).total).toBe(600);
  });

  it("reports the accounts behind each total, null for rows whose account is gone", async () => {
    const alice = await createTestUser();
    const usd = await seedAccount(alice);
    const eur = await seedAccount(alice, { currency: "EUR" });
    await seedTransaction(alice, usd, { type: "income", date: "2026-03-01" });
    await seedTransaction(alice, eur, { type: "adjustment", amount: -5, date: "2026-03-02" });
    await seedTransaction(alice, null, { date: "2026-01-15" });
    await seedTransaction(alice, eur, { type: "transfer", date: "2026-03-03", destinationAccountId: usd });

    const sorted = (ids: Array<string | null>) => [...ids].sort();
    expect(sorted(await read((t) => reports.summaryAccountIds(t, alice, "2026-03")))).toEqual(sorted([usd, eur]));
    expect(await read((t) => reports.spendingAccountIds(t, alice, "2026-03"))).toEqual([]);
    expect(await read((t) => reports.cashflowAccountIds(t, alice, "2026-03", 2))).toEqual([usd]);
    expect(await read((t) => reports.cashflowAccountIds(t, alice, "2026-03", 3))).toEqual(expect.arrayContaining([usd, null]));
  });

  describe("net worth", () => {
    it("sums unarchived asset accounts and debts for the given user only", async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      await seedAccount(alice, { balance: 250_000, currency: "EUR" });
      await seedAccount(alice, { balance: 150_000, type: "savings", currency: "EUR" });
      // Liability accounts are not assets: a debt linked to one isn't counted twice.
      const visa = await seedAccount(alice, { balance: -50_000, type: "credit_card", currency: "USD" });
      await seedAccount(alice, { balance: 999_999, archived: true });
      await seedDebt(alice, { debtType: "credit_card", originalAmount: 100_000, currentBalance: 50_000, linkedAccountId: visa });
      await seedDebt(alice, { originalAmount: 400_000, currentBalance: 300_000 });
      await seedDebt(alice, { currentBalance: 75_000, archived: true });
      await seedAccount(bob, { balance: 99_999 });

      expect(await read((t) => reports.netWorth(t, alice))).toEqual({
        hasData: true,
        totalAssets: 400_000,
        totalDebts: 350_000,
        netWorth: 50_000,
        assetCurrencies: ["EUR"],
      });
    });

    it("reports no data for a user with nothing", async () => {
      const alice = await createTestUser();
      await seedAccount(await createTestUser(), { balance: 100 });
      expect(await read((t) => reports.netWorth(t, alice))).toEqual({
        hasData: false,
        totalAssets: 0,
        totalDebts: 0,
        netWorth: 0,
        assetCurrencies: [],
      });
    });
  });

  describe("debt summary", () => {
    it("totals unarchived debts, the latest recorded payment and the five largest balances", async () => {
      const alice = await createTestUser();
      const accountId = await seedAccount(alice);
      const balances = [100, 600, 300, 600, 0, 500];
      const ids = [];
      for (const [i, currentBalance] of balances.entries()) {
        ids.push(await seedDebt(alice, { name: `D${i}`, originalAmount: 1_000, currentBalance, lender: i === 0 ? "Bank" : undefined }));
      }
      await seedDebt(alice, { currentBalance: 9_999, archived: true });
      // Recorded later but dated earlier: "latest" is the latest recorded.
      await seedDebtPayment(alice, { debtId: ids[0]!, fromAccountId: accountId, amount: 40, date: "2026-02-01" });
      await seedDebtPayment(alice, { debtId: ids[0]!, fromAccountId: null, amount: 70, date: "2026-01-01" });

      const summary = await read((t) => reports.debtSummary(t, alice));
      expect(summary).toMatchObject({ totalOriginal: 6_000, totalRemaining: 2_100, recentPayment: 70, recentPaymentAccountId: null });
      // Largest balance first; ties keep creation order.
      expect(summary.debts.map((d) => d.name)).toEqual(["D1", "D3", "D5", "D2", "D0"]);
      expect(summary.debts[4]).toMatchObject({ creditor: "Bank", percentPaid: 90 });
      expect(summary.debts[0]).toMatchObject({ creditor: "Unknown lender", percentPaid: 40 });
    });

    it("has no recent payment account without payments", async () => {
      const alice = await createTestUser();
      expect(await read((t) => reports.debtSummary(t, alice))).toEqual({
        totalOriginal: 0,
        totalRemaining: 0,
        recentPayment: 0,
        recentPaymentAccountId: undefined,
        debts: [],
      });
    });
  });
});
