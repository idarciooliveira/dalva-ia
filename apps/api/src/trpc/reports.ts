/**
 * Totals in the user's base currency. The domain sums across accounts
 * without conversion, so each report first checks that everything it sums is
 * in that currency (`conflict` otherwise: `mixed_currencies`, or
 * `unknown_currency` for legacy rows whose account is gone).
 */
import { z } from "zod";

import type { Tx } from "../db/tx";
import { toMoney } from "../domain/money";
import * as reports from "../domain/reports";
import { requireBaseCurrency } from "../domain/userProfiles";
import { requireBaseCurrencyOnly, transactionDtos } from "./currency";
import { financeRead, router } from "./init";
import { moneySchema, monthSchema, noInput } from "./schemas";
import { transactionSchema } from "./transactions";

/** The base currency, once every account behind the report is in it. */
async function reportCurrency(tx: Tx, userId: string, accountIds: Promise<Array<string | null>> | Array<string | null>) {
  const currency = await requireBaseCurrency(tx, userId);
  await requireBaseCurrencyOnly(tx, userId, currency, { accountIds: await accountIds });
  return currency;
}

const byMonth = z.strictObject({ month: monthSchema });

export const reportsRouter = router({
  transactionSummary: financeRead
    .input(byMonth)
    .output(
      z.object({
        month: monthSchema,
        totalIncome: moneySchema,
        totalExpenses: moneySchema,
        /** Signed sum of balance adjustments. Transfers are excluded from every total. */
        totalAdjustments: moneySchema,
        recentTransactions: z.array(transactionSchema),
      }),
    )
    .query(async ({ ctx: { tx, user }, input }) => {
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

  /** Sorted by amount, descending. `categoryId` is null for uncategorised spending. */
  spendingByCategory: financeRead
    .input(byMonth)
    .output(
      z.object({
        month: monthSchema,
        total: moneySchema,
        categories: z.array(z.object({ categoryId: z.string().nullable(), name: z.string(), amount: moneySchema })),
      }),
    )
    .query(async ({ ctx: { tx, user }, input }) => {
      const currency = await reportCurrency(tx, user.userId, reports.spendingAccountIds(tx, user.userId, input.month));
      const spending = await reports.spendingByCategory(tx, user.userId, input.month);
      return {
        month: input.month,
        total: toMoney(spending.total, currency),
        categories: spending.categories.map((c) => ({ categoryId: c.categoryId, name: c.name, amount: toMoney(c.amount, currency) })),
      };
    }),

  /** `trend` is oldest first, ending at `month`. */
  cashflow: financeRead
    .input(z.strictObject({ month: monthSchema, trendMonths: z.number().int().min(1).max(24).default(6) }))
    .output(
      z.object({
        currentMonth: z.object({ income: moneySchema, expenses: moneySchema, net: moneySchema }),
        trend: z.array(z.object({ month: monthSchema, income: moneySchema, expenses: moneySchema })),
      }),
    )
    .query(async ({ ctx: { tx, user }, input }) => {
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
  netWorth: financeRead
    .input(noInput)
    .output(z.object({ hasData: z.boolean(), totalAssets: moneySchema, totalDebts: moneySchema, netWorth: moneySchema }))
    .query(async ({ ctx: { tx, user } }) => {
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

  /** Up to 5 non-archived debts (paid-off ones included), largest balance first. `recentPayment` left an account, which must be in the base currency. */
  debtSummary: financeRead
    .input(noInput)
    .output(
      z.object({
        totalOriginal: moneySchema,
        totalRemaining: moneySchema,
        recentPayment: moneySchema,
        debts: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            creditor: z.string(),
            originalAmount: moneySchema,
            currentBalance: moneySchema,
            /** Rounded percentage, clamped to 0..100. */
            percentPaid: z.number().int(),
          }),
        ),
      }),
    )
    .query(async ({ ctx: { tx, user } }) => {
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
});
