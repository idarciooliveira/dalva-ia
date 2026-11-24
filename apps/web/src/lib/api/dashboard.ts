import { trpc } from "./trpc";

/*
 * Dashboard reads. Reports sit under `queryKeys.reports.all()` (transaction,
 * transfer, account and category writes invalidate it). The goals and debt
 * cards use `goalsQuery` and `debtSummaryQuery` from `queries.ts`. Every report
 * amount is in the user's base currency; a report refuses (`conflict`) when
 * accounts in another currency would feed it. Recent rows sit under the
 * transactions prefix and keep their accounts' currencies.
 */

/** As many rows as the summary report's `recentTransactions`. */
const RECENT_ROWS = 10;

/** Income, expenses, adjustments and the latest rows of a month ("YYYY-MM"). */
export const transactionSummaryQuery = (month: string) => trpc.reports.transactionSummary.queryOptions({ month });

/**
 * The month's latest rows, each in its account's currency, as the summary report
 * lists them. For when that report refuses (`conflict`: accounts in another
 * currency): these rows need no common currency.
 */
export function recentTransactionsQuery(month: string) {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  const lastDay = new Date(year, monthNumber, 0).getDate();
  return trpc.transactions.search.queryOptions({
    dateFrom: `${month}-01`,
    dateTo: `${month}-${String(lastDay).padStart(2, "0")}`,
    limit: RECENT_ROWS,
  });
}

export const spendingByCategoryQuery = (month: string) => trpc.reports.spendingByCategory.queryOptions({ month });

export const cashflowQuery = (month: string, trendMonths: number) => trpc.reports.cashflow.queryOptions({ month, trendMonths });

export const netWorthQuery = () => trpc.reports.netWorth.queryOptions();
