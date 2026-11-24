import { queryOptions } from "@tanstack/react-query";

import { api } from "./client";
import { queryKeys } from "./keys";

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

export const dashboardKeys = {
  recent: (month: string) => [...queryKeys.transactions.all(), "recent", month] as const,
  summary: (month: string) => [...queryKeys.reports.all(), "summary", month] as const,
  spending: (month: string) => [...queryKeys.reports.all(), "spending", month] as const,
  cashflow: (month: string, trendMonths: number) => [...queryKeys.reports.all(), "cashflow", month, trendMonths] as const,
  netWorth: () => [...queryKeys.reports.all(), "net-worth"] as const,
};

/** Income, expenses, adjustments and the latest rows of a month ("YYYY-MM"). */
export const transactionSummaryQuery = (month: string) =>
  queryOptions({
    queryKey: dashboardKeys.summary(month),
    queryFn: ({ signal }) => api.reports.transactionSummary({ month }, { signal }),
  });

/**
 * The month's latest rows, each in its account's currency, as the summary report
 * lists them. For when that report refuses (`conflict`: accounts in another
 * currency): these rows need no common currency.
 */
export const recentTransactionsQuery = (month: string) =>
  queryOptions({
    queryKey: dashboardKeys.recent(month),
    queryFn: ({ signal }) => {
      const [year, monthNumber] = month.split("-").map(Number) as [number, number];
      const lastDay = new Date(year, monthNumber, 0).getDate();
      return api.transactions.search(
        { dateFrom: `${month}-01`, dateTo: `${month}-${String(lastDay).padStart(2, "0")}`, limit: RECENT_ROWS },
        { signal },
      );
    },
  });

export const spendingByCategoryQuery = (month: string) =>
  queryOptions({
    queryKey: dashboardKeys.spending(month),
    queryFn: ({ signal }) => api.reports.spendingByCategory({ month }, { signal }),
  });

export const cashflowQuery = (month: string, trendMonths: number) =>
  queryOptions({
    queryKey: dashboardKeys.cashflow(month, trendMonths),
    queryFn: ({ signal }) => api.reports.cashflow({ month, trendMonths }, { signal }),
  });

export const netWorthQuery = () =>
  queryOptions({
    queryKey: dashboardKeys.netWorth(),
    queryFn: ({ signal }) => api.reports.netWorth({}, { signal }),
  });
