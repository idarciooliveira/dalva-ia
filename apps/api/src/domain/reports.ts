/**
 * Reports, ported from the report functions of
 * `packages/backend/convex/domain/transactions.ts`, `dashboard.ts` and
 * `debts.ts`. Sums are in stored minor units, across accounts, without any
 * currency conversion: callers check the currencies of what was summed
 * (`*AccountIds`, `assetCurrencies`) before labelling a total.
 *
 * Months are `YYYY-MM`; a month is the half-open range from its first day to
 * the next month's first day, so no bound is ever a day that doesn't exist.
 * Totals cover every row of the range (Convex summed the first 200, 500 or
 * 2000 rows it read). Transfers are excluded from every total.
 */
import { and, asc, desc, eq, inArray, not, sql, type SQL } from "drizzle-orm";

import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { accounts, categories, debtPayments, debts, transactions } from "../db/schema";
import type { Tx } from "../db/tx";
import { NEWEST_FIRST, type Transaction, type TransactionType } from "./transactions";

/** Account types whose balances are owed, not owned: not counted as assets. */
export const LIABILITY_ACCOUNT_TYPES = ["credit_card", "loan"] as const;

const RECENT_TRANSACTIONS = 10;
const TOP_DEBTS = 5;

/* Months ------------------------------------------------------------------- */

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Month `offset` months after `month` (negative: before). */
export function addMonths(month: string, offset: number): string {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + offset;
  return `${pad(Math.floor(total / 12), 4)}-${pad((total % 12) + 1, 2)}`;
}

/** `count` consecutive months ending at `month`, oldest first. */
export function monthsEndingAt(month: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addMonths(month, i - (count - 1)));
}

/** First day of `first` up to (excluding) the first day of the month after `last`. */
function dateRange(first: string, last = first): SQL {
  return sql`${transactions.date} >= ${`${first}-01`}::date and ${transactions.date} < ${`${addMonths(last, 1)}-01`}::date`;
}

/** Sum of `amount` (over the rows matching `where`), 0 for none. sum(bigint) is numeric: read as a JS number. */
const total = (amount: AnyPgColumn, where?: SQL) =>
  (where ? sql<number>`coalesce(sum(${amount}) filter (where ${where}), 0)` : sql<number>`coalesce(sum(${amount}), 0)`).mapWith(Number);
const ofType = (type: TransactionType) => sql`${transactions.type} = ${type}`;

/**
 * Accounts of the rows a report sums: the range, restricted to the types it
 * adds up. Null for rows whose account is gone (legacy), whose currency is
 * unknown.
 */
async function accountIdsIn(tx: Tx, userId: string, range: SQL, types: readonly TransactionType[]): Promise<Array<string | null>> {
  const rows = await tx
    .selectDistinct({ accountId: transactions.accountId })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), range, inArray(transactions.type, [...types])));
  return rows.map((r) => r.accountId);
}

/* Transaction summary ------------------------------------------------------ */

const SUMMARY_TYPES = ["income", "expense", "adjustment"] as const;

export const summaryAccountIds = (tx: Tx, userId: string, month: string) => accountIdsIn(tx, userId, dateRange(month), SUMMARY_TYPES);

/** Income, expense and (signed) adjustment totals of the month, and its 10 newest rows (transfer legs included). */
export async function transactionSummary(
  tx: Tx,
  userId: string,
  month: string,
): Promise<{ totalIncome: number; totalExpenses: number; totalAdjustments: number; recentTransactions: Transaction[] }> {
  const where = and(eq(transactions.userId, userId), dateRange(month));
  const [totals] = await tx
    .select({
      totalIncome: total(transactions.amount, ofType("income")),
      totalExpenses: total(transactions.amount, ofType("expense")),
      totalAdjustments: total(transactions.amount, ofType("adjustment")),
    })
    .from(transactions)
    .where(where);
  const recentTransactions = await tx
    .select()
    .from(transactions)
    .where(where)
    .orderBy(...NEWEST_FIRST)
    .limit(RECENT_TRANSACTIONS);
  return { ...totals!, recentTransactions };
}

/* Spending by category ----------------------------------------------------- */

export const spendingAccountIds = (tx: Tx, userId: string, month: string) => accountIdsIn(tx, userId, dateRange(month), ["expense"]);

/** Expenses of the month per category, largest first; uncategorised spending is one `categoryId: null` entry. */
export async function spendingByCategory(
  tx: Tx,
  userId: string,
  month: string,
): Promise<{ total: number; categories: Array<{ categoryId: string | null; name: string; amount: number }> }> {
  const amount = total(transactions.amount);
  const rows = await tx
    .select({ categoryId: transactions.categoryId, name: categories.name, amount })
    .from(transactions)
    .leftJoin(categories, and(eq(categories.id, transactions.categoryId), eq(categories.userId, userId)))
    .where(and(eq(transactions.userId, userId), dateRange(month), eq(transactions.type, "expense")))
    .groupBy(transactions.categoryId, categories.name)
    .orderBy(desc(amount), sql`${categories.name} asc nulls last`);
  return {
    total: rows.reduce((sum, r) => sum + r.amount, 0),
    categories: rows.map((r) =>
      r.categoryId === null
        ? { categoryId: null, name: "Uncategorized", amount: r.amount }
        : { categoryId: r.categoryId, name: r.name ?? "Unknown", amount: r.amount },
    ),
  };
}

/* Cashflow ----------------------------------------------------------------- */

export const cashflowAccountIds = (tx: Tx, userId: string, month: string, trendMonths: number) =>
  accountIdsIn(tx, userId, dateRange(addMonths(month, 1 - trendMonths), month), ["income", "expense"]);

/** Income and expenses of `month` and of each of the `trendMonths` months ending at it (oldest first). */
export async function cashflow(
  tx: Tx,
  userId: string,
  month: string,
  trendMonths: number,
): Promise<{
  currentMonth: { income: number; expenses: number; net: number };
  trend: Array<{ month: string; income: number; expenses: number }>;
}> {
  const months = monthsEndingAt(month, trendMonths);
  const bucket = sql<string>`to_char(${transactions.date}, 'YYYY-MM')`;
  const rows = await tx
    .select({
      month: bucket,
      income: total(transactions.amount, ofType("income")),
      expenses: total(transactions.amount, ofType("expense")),
    })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), dateRange(months[0]!, month), inArray(transactions.type, ["income", "expense"])))
    .groupBy(bucket);
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const trend = months.map((m) => ({ month: m, income: byMonth.get(m)?.income ?? 0, expenses: byMonth.get(m)?.expenses ?? 0 }));
  const current = trend.at(-1)!;
  return { currentMonth: { income: current.income, expenses: current.expenses, net: current.income - current.expenses }, trend };
}

/* Net worth ---------------------------------------------------------------- */

/**
 * Balances of unarchived non-liability accounts, minus the remaining balance
 * of unarchived debts. Liability accounts are left out so a debt linked to one
 * isn't counted twice.
 */
export async function netWorth(
  tx: Tx,
  userId: string,
): Promise<{ hasData: boolean; totalAssets: number; totalDebts: number; netWorth: number; assetCurrencies: string[] }> {
  const isAsset = not(inArray(accounts.type, [...LIABILITY_ACCOUNT_TYPES]));
  const [assets] = await tx
    .select({
      count: sql<number>`count(*)`.mapWith(Number),
      totalAssets: total(accounts.balance, isAsset),
      assetCurrencies: sql<string[]>`coalesce(array_agg(distinct ${accounts.currency}) filter (where ${isAsset}), '{}')`,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.archived, false)));
  const [owed] = await tx
    .select({ count: sql<number>`count(*)`.mapWith(Number), totalDebts: total(debts.currentBalance) })
    .from(debts)
    .where(and(eq(debts.userId, userId), eq(debts.archived, false)));
  return {
    hasData: assets!.count > 0 || owed!.count > 0,
    totalAssets: assets!.totalAssets,
    totalDebts: owed!.totalDebts,
    netWorth: assets!.totalAssets - owed!.totalDebts,
    assetCurrencies: assets!.assetCurrencies,
  };
}

/* Debt summary ------------------------------------------------------------- */

/**
 * Totals of unarchived debts, the latest recorded payment, and the five
 * largest remaining balances (paid-off debts included). `recentPaymentAccountId`
 * is the account the latest payment came out of: undefined without payments,
 * null when that account is gone (legacy).
 */
export async function debtSummary(
  tx: Tx,
  userId: string,
): Promise<{
  totalOriginal: number;
  totalRemaining: number;
  recentPayment: number;
  recentPaymentAccountId: string | null | undefined;
  debts: Array<{ id: string; name: string; creditor: string; originalAmount: number; currentBalance: number; percentPaid: number }>;
}> {
  const live = and(eq(debts.userId, userId), eq(debts.archived, false));
  const [totals] = await tx
    .select({ totalOriginal: total(debts.originalAmount), totalRemaining: total(debts.currentBalance) })
    .from(debts)
    .where(live);
  const top = await tx
    .select()
    .from(debts)
    .where(live)
    .orderBy(desc(debts.currentBalance), asc(debts.createdAt), asc(debts.id))
    .limit(TOP_DEBTS);
  // Latest recorded, as Convex (`_creationTime`), not latest dated.
  const [recent] = await tx
    .select({ amount: debtPayments.amount, fromAccountId: debtPayments.fromAccountId })
    .from(debtPayments)
    .where(eq(debtPayments.userId, userId))
    .orderBy(desc(debtPayments.createdAt), desc(debtPayments.id))
    .limit(1);
  return {
    ...totals!,
    recentPayment: recent?.amount ?? 0,
    recentPaymentAccountId: recent ? recent.fromAccountId : undefined,
    debts: top.map((d) => ({
      id: d.id,
      name: d.name,
      creditor: d.lender ?? "Unknown lender",
      originalAmount: d.originalAmount,
      currentBalance: d.currentBalance,
      percentPaid: d.originalAmount === 0 ? 0 : Math.round(((d.originalAmount - d.currentBalance) / d.originalAmount) * 100),
    })),
  };
}
