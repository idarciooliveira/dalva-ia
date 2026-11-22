import { queryOptions } from "@tanstack/react-query";

import { api } from "./client";
import { queryKeys } from "./keys";

/*
 * Dashboard reads. Reports sit under `queryKeys.reports.all()` (transaction,
 * transfer, account and category writes invalidate it); the goals list and the
 * debt summary under the goals and debts prefixes their own writes invalidate.
 * Every amount here is in the user's base currency; a report refuses (`conflict`)
 * when accounts in another currency would feed it.
 */

export const dashboardKeys = {
  summary: (month: string) => [...queryKeys.reports.all(), "summary", month] as const,
  spending: (month: string) => [...queryKeys.reports.all(), "spending", month] as const,
  cashflow: (month: string, trendMonths: number) => [...queryKeys.reports.all(), "cashflow", month, trendMonths] as const,
  netWorth: () => [...queryKeys.reports.all(), "net-worth"] as const,
  goals: () => [...queryKeys.goals.all(), "list", {}] as const,
  debtSummary: () => [...queryKeys.debts.all(), "summary"] as const,
};

/** Income, expenses, adjustments and the latest rows of a month ("YYYY-MM"). */
export const transactionSummaryQuery = (month: string) =>
  queryOptions({
    queryKey: dashboardKeys.summary(month),
    queryFn: ({ signal }) => api.reports.transactionSummary({ month }, { signal }),
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

/** Active goals, for the progress card. */
export const dashboardGoalsQuery = () =>
  queryOptions({
    queryKey: dashboardKeys.goals(),
    queryFn: ({ signal }) => api.goals.list({}, { signal }),
  });

export const debtSummaryQuery = () =>
  queryOptions({
    queryKey: dashboardKeys.debtSummary(),
    queryFn: ({ signal }) => api.reports.debtSummary({}, { signal }),
  });
