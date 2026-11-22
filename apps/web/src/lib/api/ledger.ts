import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { RouteInput, UserRoutes } from "@mpf/finance-contract";

import { api } from "./client";
import { queryKeys } from "./keys";

/*
 * Transactions and transfers. Every key sits under `queryKeys.transactions.all()`,
 * so one invalidation of that prefix (see INVALIDATES) refreshes lists, single
 * rows and transfers alike.
 */

export type TransactionSearch = Omit<RouteInput<UserRoutes["transactions"]["search"]>, "cursor" | "limit">;

/** Rows per page of the transactions list. */
export const TRANSACTIONS_PAGE_SIZE = 25;

export const ledgerKeys = {
  search: (input: TransactionSearch) => [...queryKeys.transactions.all(), "search", input] as const,
  transfer: (id: string) => [...queryKeys.transactions.all(), "transfer", id] as const,
};

/** Newest first, a page at a time: `fetchNextPage` follows the API's cursor. */
export const transactionsSearchQuery = (input: TransactionSearch) =>
  infiniteQueryOptions({
    queryKey: ledgerKeys.search(input),
    queryFn: ({ pageParam, signal }) =>
      api.transactions.search(
        { ...input, limit: TRANSACTIONS_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

/** Both legs of a transfer from either leg's id. */
export const transferQuery = (id: string) =>
  queryOptions({
    queryKey: ledgerKeys.transfer(id),
    queryFn: ({ signal }) => api.transfers.get({ id }, { signal }),
  });
