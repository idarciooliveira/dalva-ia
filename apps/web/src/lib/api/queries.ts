import { queryOptions } from "@tanstack/react-query";
import type { RouteInput, UserRoutes } from "@mpf/finance-contract";

import { api } from "./client";
import { queryKeys } from "./keys";

export const profileQuery = () =>
  queryOptions({
    queryKey: queryKeys.profile(),
    queryFn: ({ signal }) => api.profile.get({}, { signal }),
  });

export const accountsQuery = (input: RouteInput<UserRoutes["accounts"]["list"]> = {}) =>
  queryOptions({
    queryKey: queryKeys.accounts.list(input),
    queryFn: ({ signal }) => api.accounts.list(input, { signal }),
  });

export const categoriesQuery = (input: RouteInput<UserRoutes["categories"]["list"]> = {}) =>
  queryOptions({
    queryKey: queryKeys.categories.list(input),
    queryFn: ({ signal }) => api.categories.list(input, { signal }),
  });

export const subcategoriesQuery = (input: RouteInput<UserRoutes["subcategories"]["list"]> = {}) =>
  queryOptions({
    queryKey: queryKeys.subcategories.list(input),
    queryFn: ({ signal }) => api.subcategories.list(input, { signal }),
  });

export const defaultCategoriesQuery = () =>
  queryOptions({
    queryKey: queryKeys.categories.defaults(),
    queryFn: ({ signal }) => api.categories.defaults({}, { signal }),
    // A constant list served by the API.
    staleTime: Infinity,
  });

export const goalsQuery = (input: RouteInput<UserRoutes["goals"]["list"]> = {}) =>
  queryOptions({
    queryKey: queryKeys.goals.list(input),
    queryFn: ({ signal }) => api.goals.list(input, { signal }),
  });

export const goalContributionsQuery = (goalId: string) =>
  queryOptions({
    queryKey: queryKeys.goalContributions.list(goalId),
    queryFn: ({ signal }) => api.goalContributions.list({ goalId }, { signal }),
  });

export const debtsQuery = (input: RouteInput<UserRoutes["debts"]["list"]> = {}) =>
  queryOptions({
    queryKey: queryKeys.debts.list(input),
    queryFn: ({ signal }) => api.debts.list(input, { signal }),
  });

export const debtPaymentsQuery = (debtId: string) =>
  queryOptions({
    queryKey: queryKeys.debtPayments.list(debtId),
    queryFn: ({ signal }) => api.debtPayments.list({ debtId }, { signal }),
  });

export const debtSummaryQuery = () =>
  queryOptions({
    queryKey: queryKeys.reports.debtSummary(),
    queryFn: ({ signal }) => api.reports.debtSummary({}, { signal }),
  });

export const chatLinksQuery = () =>
  queryOptions({
    queryKey: queryKeys.chatLinks.all(),
    queryFn: ({ signal }) => api.chatLinks.list({}, { signal }),
  });
