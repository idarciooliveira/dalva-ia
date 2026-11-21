import { routes } from "@mpf/finance-contract";

import type { Tx } from "../../db/tx";
import * as reports from "../../domain/reports";
import { toMoney } from "../../domain/money";
import { operation } from "../operation";
import { requireBaseCurrency, requireBaseCurrencyOnly, transactionDtos } from "./currency";

/** The base currency, once every account behind the report is in it. */
async function reportCurrency(tx: Tx, userId: string, accountIds: Promise<Array<string | null>> | Array<string | null>) {
  const currency = await requireBaseCurrency(tx, userId);
  await requireBaseCurrencyOnly(tx, userId, currency, { accountIds: await accountIds });
  return currency;
}

/*
 * Totals are labelled with the user's base currency. The domain sums across
 * accounts without conversion, so each report first checks that everything it
 * sums is in that currency (`conflict` otherwise).
 */
export const reportOperations = {
  transactionSummary: operation(routes.reports.transactionSummary, async (tx, user, input) => {
    const currency = await reportCurrency(tx, user.userId, reports.summaryAccountIds(tx, user.userId, input.month));
    const summary = await reports.transactionSummary(tx, user.userId, input.month);
    return {
      month: input.month,
      totalIncome: toMoney(summary.totalIncome, currency),
      totalExpenses: toMoney(summary.totalExpenses, currency),
      totalAdjustments: toMoney(summary.totalAdjustments, currency),
      recentTransactions: await transactionDtos(tx, user.userId, summary.recentTransactions),
    };
  }),

  spendingByCategory: operation(routes.reports.spendingByCategory, async (tx, user, input) => {
    const currency = await reportCurrency(tx, user.userId, reports.spendingAccountIds(tx, user.userId, input.month));
    const spending = await reports.spendingByCategory(tx, user.userId, input.month);
    return {
      month: input.month,
      total: toMoney(spending.total, currency),
      categories: spending.categories.map((c) => ({ categoryId: c.categoryId, name: c.name, amount: toMoney(c.amount, currency) })),
    };
  }),

  cashflow: operation(routes.reports.cashflow, async (tx, user, input) => {
    const currency = await reportCurrency(tx, user.userId, reports.cashflowAccountIds(tx, user.userId, input.month, input.trendMonths));
    const flow = await reports.cashflow(tx, user.userId, input.month, input.trendMonths);
    return {
      currentMonth: {
        income: toMoney(flow.currentMonth.income, currency),
        expenses: toMoney(flow.currentMonth.expenses, currency),
        net: toMoney(flow.currentMonth.net, currency),
      },
      trend: flow.trend.map((p) => ({ month: p.month, income: toMoney(p.income, currency), expenses: toMoney(p.expenses, currency) })),
    };
  }),

  /** Assets are summed account balances; debts carry no currency and are in the base currency. */
  netWorth: operation(routes.reports.netWorth, async (tx, user) => {
    const currency = await requireBaseCurrency(tx, user.userId);
    const worth = await reports.netWorth(tx, user.userId);
    await requireBaseCurrencyOnly(tx, user.userId, currency, { currencies: worth.assetCurrencies });
    return {
      hasData: worth.hasData,
      totalAssets: toMoney(worth.totalAssets, currency),
      totalDebts: toMoney(worth.totalDebts, currency),
      netWorth: toMoney(worth.netWorth, currency),
    };
  }),

  /** Debt totals are in the base currency; `recentPayment` came out of an account, which must match it. */
  debtSummary: operation(routes.reports.debtSummary, async (tx, user) => {
    const summary = await reports.debtSummary(tx, user.userId);
    const currency = await reportCurrency(tx, user.userId, summary.recentPaymentAccountId === undefined ? [] : [summary.recentPaymentAccountId]);
    return {
      totalOriginal: toMoney(summary.totalOriginal, currency),
      totalRemaining: toMoney(summary.totalRemaining, currency),
      recentPayment: toMoney(summary.recentPayment, currency),
      debts: summary.debts.map((d) => ({
        id: d.id,
        name: d.name,
        creditor: d.creditor,
        originalAmount: toMoney(d.originalAmount, currency),
        currentBalance: toMoney(d.currentBalance, currency),
        percentPaid: d.percentPaid,
      })),
    };
  }),
};
