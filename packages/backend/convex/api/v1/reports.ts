import { routes } from "@mpf/finance-contract";

import { getNetWorth } from "../../domain/dashboard";
import { getDebtSummary } from "../../domain/debts";
import * as transactions from "../../domain/transactions";
import { apiQuery } from "./define";
import { toMoney } from "./money";
import { monthsEndingAt, requireBaseCurrency, transactionDtos } from "./shared";

/*
 * Aggregates are labelled with the user's base currency. The domain sums
 * amounts across accounts without conversion, so a user with accounts in
 * several currencies gets mixed totals (no FX in v1).
 */

export const transactionSummary = apiQuery(routes.reports.transactionSummary, async (ctx, userId, input) => {
  const currency = await requireBaseCurrency(ctx, userId);
  const summary = await transactions.getTransactionSummary(ctx, userId, { month: input.month });
  return {
    month: input.month,
    totalIncome: toMoney(summary.totalIncome, currency),
    totalExpenses: toMoney(summary.totalExpenses, currency),
    totalAdjustments: toMoney(summary.totalAdjustments, currency),
    recentTransactions: await transactionDtos(ctx, userId, summary.recentTransactions),
  };
});

export const spendingByCategory = apiQuery(routes.reports.spendingByCategory, async (ctx, userId, input) => {
  const currency = await requireBaseCurrency(ctx, userId);
  const spending = await transactions.getSpendingByCategory(ctx, userId, { month: input.month });
  return {
    month: input.month,
    total: toMoney(spending.total, currency),
    categories: spending.categories.map((c) => ({
      categoryId: c.categoryId,
      name: c.name,
      amount: toMoney(c.amount, currency),
    })),
  };
});

export const cashflow = apiQuery(routes.reports.cashflow, async (ctx, userId, input) => {
  const currency = await requireBaseCurrency(ctx, userId);
  const flow = await transactions.getCashflow(ctx, userId, { month: input.month, trendMonths: input.trendMonths });
  // The domain labels trend entries "Jan".."Dec"; it returns the same
  // consecutive months, oldest first, so the YYYY-MM keys line up by index.
  const months = monthsEndingAt(input.month, input.trendMonths);
  return {
    currentMonth: {
      income: toMoney(flow.currentMonth.income, currency),
      expenses: toMoney(flow.currentMonth.expenses, currency),
      net: toMoney(flow.currentMonth.net, currency),
    },
    trend: flow.trend.map((point, i) => ({
      month: months[i]!,
      income: toMoney(point.income, currency),
      expenses: toMoney(point.expenses, currency),
    })),
  };
});

export const netWorth = apiQuery(routes.reports.netWorth, async (ctx, userId) => {
  const currency = await requireBaseCurrency(ctx, userId);
  const worth = await getNetWorth(ctx, userId);
  return {
    hasData: worth.hasData,
    totalAssets: toMoney(worth.totalAssets, currency),
    totalDebts: toMoney(worth.totalDebts, currency),
    netWorth: toMoney(worth.netWorth, currency),
  };
});

export const debtSummary = apiQuery(routes.reports.debtSummary, async (ctx, userId) => {
  const currency = await requireBaseCurrency(ctx, userId);
  const summary = await getDebtSummary(ctx, userId);
  return {
    totalOriginal: toMoney(summary.totalOriginal, currency),
    totalRemaining: toMoney(summary.totalRemaining, currency),
    recentPayment: toMoney(summary.recentPayment, currency),
    debts: summary.debts.map((d) => ({
      id: d.id as string,
      name: d.name,
      creditor: d.creditor,
      originalAmount: toMoney(d.originalAmount, currency),
      currentBalance: toMoney(d.currentBalance, currency),
      percentPaid: Math.min(100, Math.max(0, d.percentPaid)),
    })),
  };
});
