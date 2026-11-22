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
