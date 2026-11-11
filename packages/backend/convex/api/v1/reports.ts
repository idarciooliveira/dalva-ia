import { routes } from "@mpf/finance-contract";

import { getNetWorth, netWorthAssetAccounts } from "../../domain/dashboard";
import { getDebtSummary, getMostRecentDebtPayment } from "../../domain/debts";
import * as transactions from "../../domain/transactions";
import { apiQuery } from "./define";
import { toMoney } from "./money";
import { monthsEndingAt, requireBaseCurrency, requireBaseCurrencyOnly, transactionDtos } from "./shared";

/*
 * Aggregates are labelled with the user's base currency. The domain sums
 * across accounts without conversion, so each report first checks that every
 * account it sums is in the base currency (`conflict` otherwise).
 */

const monthRange = (month: string) => ({ dateFrom: `${month}-01`, dateTo: `${month}-31` });

export const transactionSummary = apiQuery(routes.reports.transactionSummary, async (ctx, userId, input) => {
  const currency = await requireBaseCurrency(ctx, userId);
  const accountIds = await transactions.reportAccountIds(ctx, userId, { report: "summary", ...monthRange(input.month) });
  await requireBaseCurrencyOnly(ctx, userId, currency, { accountIds });
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
  const accountIds = await transactions.reportAccountIds(ctx, userId, { report: "spending", ...monthRange(input.month) });
  await requireBaseCurrencyOnly(ctx, userId, currency, { accountIds });
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
  // The domain labels trend entries "Jan".."Dec"; it returns the same
  // consecutive months, oldest first, so the YYYY-MM keys line up by index.
  const months = monthsEndingAt(input.month, input.trendMonths);
  const accountIds = await transactions.reportAccountIds(ctx, userId, {
    report: "cashflow",
    dateFrom: `${months[0]}-01`,
    dateTo: `${input.month}-31`,
  });
  await requireBaseCurrencyOnly(ctx, userId, currency, { accountIds });
  const flow = await transactions.getCashflow(ctx, userId, { month: input.month, trendMonths: input.trendMonths });
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

/** Assets are summed account balances; debts carry no currency and are in the base currency. */
export const netWorth = apiQuery(routes.reports.netWorth, async (ctx, userId) => {
  const currency = await requireBaseCurrency(ctx, userId);
  const assets = await netWorthAssetAccounts(ctx, userId);
  await requireBaseCurrencyOnly(ctx, userId, currency, { currencies: assets.map((a) => a.currency) });
  const worth = await getNetWorth(ctx, userId);
  return {
    hasData: worth.hasData,
    totalAssets: toMoney(worth.totalAssets, currency),
    totalDebts: toMoney(worth.totalDebts, currency),
    netWorth: toMoney(worth.netWorth, currency),
  };
});

/** Debt totals are in the base currency; `recentPayment` came out of an account, which must match it. */
export const debtSummary = apiQuery(routes.reports.debtSummary, async (ctx, userId) => {
  const currency = await requireBaseCurrency(ctx, userId);
  const recent = await getMostRecentDebtPayment(ctx, userId);
  await requireBaseCurrencyOnly(ctx, userId, currency, { accountIds: recent ? [recent.fromAccountId] : [] });
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
