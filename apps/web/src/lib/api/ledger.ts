import type { RouterInputs } from "./trpc";
import { trpc } from "./trpc";

/*
 * Transactions and transfers. Search keys sit under `queryKeys.transactions.all()`,
 * transfers under `queryKeys.transfers.all()`; every ledger write invalidates
 * both (see INVALIDATES).
 */

export type TransactionSearch = Omit<NonNullable<RouterInputs["transactions"]["search"]>, "cursor" | "limit">;

/** Rows per page of the transactions list. */
const TRANSACTIONS_PAGE_SIZE = 25;

/** Newest first, a page at a time: `fetchNextPage` follows the API's cursor. */
export const transactionsSearchQuery = (input: TransactionSearch) =>
  trpc.transactions.search.infiniteQueryOptions(
    { ...input, limit: TRANSACTIONS_PAGE_SIZE },
    { initialCursor: undefined, getNextPageParam: (page) => page.nextCursor ?? undefined },
  );

/** Both legs of a transfer from either leg's id. */
export const transferQuery = (id: string) => trpc.transfers.get.queryOptions({ id });
