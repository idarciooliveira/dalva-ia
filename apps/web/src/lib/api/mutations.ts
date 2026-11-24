import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MutationKey, QueryClient, QueryKey, UseMutationOptions } from "@tanstack/react-query";
import type { CallOptions, RouteDef, RouteInput, RouteOutput, UserRoutes } from "@mpf/finance-contract";
import { useState } from "react";

import { api } from "./client";
import { isApiError } from "./errors";
import { createIdempotencyKeys } from "./idempotency";
import { queryKeys } from "./keys";
import type { RouterInputs } from "./trpc";

type Group = keyof UserRoutes;
type WriteOp<G extends Group> = {
  [O in keyof UserRoutes[G]]: UserRoutes[G][O] extends { method: "GET" } ? never : O;
}[keyof UserRoutes[G]];
type Def<G extends Group, O extends keyof UserRoutes[G]> = UserRoutes[G][O] extends RouteDef ? UserRoutes[G][O] : never;
type MutationName = { [G in Group]: `${G}.${WriteOp<G> & string}` }[Group];

const LEDGER_WRITE = [queryKeys.accounts.all, queryKeys.transactions.all, queryKeys.reports.all];

/**
 * What each write makes stale. A write invalidates these prefixes on success and
 * waits for the active queries to refetch, so a dialog closes on fresh data.
 * Writes not listed invalidate nothing (their pages move in PR 10).
 */
const INVALIDATES: Partial<Record<MutationName, ReadonlyArray<() => QueryKey>>> = {
  "profile.create": [queryKeys.profile],
  "profile.completeOnboarding": [queryKeys.profile],
  // Transactions and transfers move account balances, so net worth, the monthly
  // reports and every list (and open transfer) change with them.
  "transactions.create": LEDGER_WRITE,
  "transactions.update": LEDGER_WRITE,
  "transactions.delete": LEDGER_WRITE,
  "transfers.create": LEDGER_WRITE,
  "transfers.update": LEDGER_WRITE,
  "transfers.delete": LEDGER_WRITE,
  "categories.seedDefaults": [queryKeys.categories.all],
  "categories.create": [queryKeys.categories.all],
  "categories.update": [queryKeys.categories.all, queryKeys.transactions.all, queryKeys.reports.all],
  // Archiving a category archives its subcategories too.
  "categories.archive": [queryKeys.categories.all, queryKeys.subcategories.all],
  "categories.restore": [queryKeys.categories.all],
  // Deleting one leaves its transactions uncategorised.
  "categories.delete": [
    queryKeys.categories.all,
    queryKeys.subcategories.all,
    queryKeys.transactions.all,
    queryKeys.reports.all,
  ],
  "subcategories.create": [queryKeys.subcategories.all],
  "subcategories.update": [queryKeys.subcategories.all, queryKeys.transactions.all],
  "subcategories.archive": [queryKeys.subcategories.all],
  "subcategories.restore": [queryKeys.subcategories.all],
  "subcategories.delete": [queryKeys.subcategories.all, queryKeys.transactions.all],
  // Goals feed the dashboard's goals card.
  "goals.create": [queryKeys.goals.all],
  "goals.update": [queryKeys.goals.all],
  "goals.archive": [queryKeys.goals.all],
  "goals.restore": [queryKeys.goals.all],
  // Its contribution transfers stay, as plain transfers.
  "goals.delete": [queryKeys.goals.all, queryKeys.transactions.all],
  // A contribution to an account-linked goal is a transfer: balances, transactions and reports move.
  "goalContributions.add": [
    queryKeys.goalContributions.all,
    queryKeys.goals.all,
    queryKeys.accounts.all,
    queryKeys.transactions.all,
    queryKeys.reports.all,
  ],
  "goalContributions.remove": [
    queryKeys.goalContributions.all,
    queryKeys.goals.all,
    queryKeys.accounts.all,
    queryKeys.transactions.all,
    queryKeys.reports.all,
  ],
  // The debt summary is a report.
  "debts.create": [queryKeys.debts.all, queryKeys.reports.all],
  "debts.update": [queryKeys.debts.all, queryKeys.reports.all],
  "debts.archive": [queryKeys.debts.all, queryKeys.reports.all],
  "debts.restore": [queryKeys.debts.all, queryKeys.reports.all],
  // Deletes its payments' transactions and reverses their balance effects.
  "debts.delete": [queryKeys.debts.all, queryKeys.accounts.all, queryKeys.transactions.all, queryKeys.reports.all],
  "debtPayments.record": [
    queryKeys.debtPayments.all,
    queryKeys.debts.all,
    queryKeys.accounts.all,
    queryKeys.transactions.all,
    queryKeys.reports.all,
  ],
  "debtPayments.remove": [
    queryKeys.debtPayments.all,
    queryKeys.debts.all,
    queryKeys.accounts.all,
    queryKeys.transactions.all,
    queryKeys.reports.all,
  ],
  // A new code changes no link; the page polls the list until the bot redeems it.
  // `chatHistory.delete` changes nothing the web reads, so it has no entry.
  "chatLinks.unlink": [queryKeys.chatLinks.all],
  "chatLinks.setReadOnly": [queryKeys.chatLinks.all],
};

async function invalidateAfter(queryClient: QueryClient, name: MutationName): Promise<void> {
  await Promise.all((INVALIDATES[name] ?? []).map((key) => queryClient.invalidateQueries({ queryKey: key() })));
}

type Options<G extends Group, O extends WriteOp<G>> = Omit<
  UseMutationOptions<RouteOutput<Def<G, O>>, Error, RouteInput<Def<G, O>>>,
  "mutationFn"
>;

/**
 * A contract write as a React Query mutation: `useApiMutation("accounts", "create")`.
 *
 * - Sends one `Idempotency-Key` per submit, reused when the same input is sent
 *   again before a success (React Query retries, a second click), so the server
 *   replays the first write instead of applying it twice.
 * - On success, invalidates `INVALIDATES[group.op]` before the caller's `onSuccess`.
 *   So does `not_found`: the record is already gone (changed elsewhere), and the
 *   lists still showing it are stale.
 */
export function useApiMutation<G extends Group, O extends WriteOp<G>>(group: G, op: O, options: Options<G, O> = {}) {
  const queryClient = useQueryClient();
  const [keys] = useState(() => createIdempotencyKeys());
  const name = `${group}.${String(op)}` as MutationName;
  const call = (api as unknown as Record<string, Record<string, (input: unknown, o: CallOptions) => Promise<unknown>>>)[
    group
  ]![op as string]!;

  return useMutation<RouteOutput<Def<G, O>>, Error, RouteInput<Def<G, O>>>({
    ...options,
    mutationFn: async (input) => {
      const idempotencyKey = keys.keyFor(input);
      const result = await call(input, { idempotencyKey });
      keys.settled(idempotencyKey);
      return result as RouteOutput<Def<G, O>>;
    },
    onSuccess: async (...args) => {
      await invalidateAfter(queryClient, name);
      await options.onSuccess?.(...args);
    },
    onError: async (...args) => {
      if (isApiError(args[0], "not_found")) void invalidateAfter(queryClient, name);
      await options.onError?.(...args);
    },
  });
}

/* tRPC writes (/api/trpc) ----------------------------------------------------- */

type TrpcWrite = `accounts.${Exclude<keyof RouterInputs["accounts"], "list" | "get">}`;

/** What each tRPC write makes stale, as `INVALIDATES` for the contract writes. */
const TRPC_INVALIDATES: Record<TrpcWrite, ReadonlyArray<() => QueryKey>> = {
  // Balances feed net worth and the account filters of the transaction pages.
  "accounts.create": [queryKeys.accounts.all, queryKeys.reports.all],
  // The type moves a balance between assets and debts in net worth.
  "accounts.update": [queryKeys.accounts.all, queryKeys.transactions.all, queryKeys.reports.all],
  "accounts.adjust": [queryKeys.accounts.all, queryKeys.transactions.all, queryKeys.reports.all],
  "accounts.archive": [queryKeys.accounts.all, queryKeys.reports.all],
  "accounts.restore": [queryKeys.accounts.all, queryKeys.reports.all],
  "accounts.delete": [queryKeys.accounts.all, queryKeys.reports.all],
};

async function invalidateAfterTrpc(queryClient: QueryClient, mutationKey: MutationKey): Promise<void> {
  // tRPC mutation keys are `[["accounts", "create"]]`.
  const name = (mutationKey[0] as string[]).join(".") as TrpcWrite;
  await Promise.all((TRPC_INVALIDATES[name] ?? []).map((key) => queryClient.invalidateQueries({ queryKey: key() })));
}

/**
 * A tRPC write as a React Query mutation, with the same invalidation rules as
 * `useApiMutation`: `useTrpcMutation(trpc.accounts.create.mutationOptions())`.
 * The `Idempotency-Key` comes from `idempotencyLink` (`./trpc.ts`).
 */
export function useTrpcMutation<TData, TError, TVariables, TContext>(
  options: UseMutationOptions<TData, TError, TVariables, TContext> & { mutationKey: MutationKey },
) {
  const queryClient = useQueryClient();
  return useMutation<TData, TError, TVariables, TContext>({
    ...options,
    onSuccess: async (...args) => {
      await invalidateAfterTrpc(queryClient, options.mutationKey);
      await options.onSuccess?.(...args);
    },
    onError: async (...args) => {
      if (isApiError(args[0], "not_found")) void invalidateAfterTrpc(queryClient, options.mutationKey);
      await options.onError?.(...args);
    },
  });
}
