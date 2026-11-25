import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient, QueryKey, UseMutationOptions } from "@tanstack/react-query";
import type { TRPCClientError } from "@trpc/client";
import type { AppRouter } from "@mpf/api/trpc";

import { isApiError } from "./errors";
import { queryKeys } from "./keys";
import { trpc, type RouterInputs, type RouterOutputs } from "./trpc";

type Proxy = typeof trpc;
type Group = keyof RouterInputs & keyof Proxy;
/** The mutations of a router. */
type WriteOp<G extends Group> = {
  [O in keyof Proxy[G]]: Proxy[G][O] extends { mutationOptions: unknown } ? O : never;
}[keyof Proxy[G]] &
  keyof RouterInputs[G] &
  string;
type MutationName = { [G in Group]: `${G & string}.${WriteOp<G>}` }[Group];

/** Rows and transfers: their lists, open transfers and single rows. */
const LEDGER = [queryKeys.transactions.all, queryKeys.transfers.all];
const LEDGER_WRITE = [queryKeys.accounts.all, ...LEDGER, queryKeys.reports.all];

/**
 * What each write makes stale. A write invalidates these prefixes on success and
 * waits for the active queries to refetch, so a dialog closes on fresh data.
 */
const INVALIDATES: Partial<Record<MutationName, ReadonlyArray<() => QueryKey>>> = {
  "profile.create": [queryKeys.profile],
  "profile.completeOnboarding": [queryKeys.profile],
  // Balances feed net worth and the account filters of the transaction pages.
  "accounts.create": [queryKeys.accounts.all, queryKeys.reports.all],
  // The type moves a balance between assets and debts in net worth.
  "accounts.update": [queryKeys.accounts.all, ...LEDGER, queryKeys.reports.all],
  "accounts.adjust": LEDGER_WRITE,
  "accounts.archive": [queryKeys.accounts.all, queryKeys.reports.all],
  "accounts.restore": [queryKeys.accounts.all, queryKeys.reports.all],
  "accounts.delete": [queryKeys.accounts.all, queryKeys.reports.all],
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
  "categories.update": [queryKeys.categories.all, ...LEDGER, queryKeys.reports.all],
  // Archiving a category archives its subcategories too.
  "categories.archive": [queryKeys.categories.all, queryKeys.subcategories.all],
  "categories.restore": [queryKeys.categories.all],
  // Deleting one leaves its transactions uncategorised.
  "categories.delete": [queryKeys.categories.all, queryKeys.subcategories.all, ...LEDGER, queryKeys.reports.all],
  "subcategories.create": [queryKeys.subcategories.all],
  "subcategories.update": [queryKeys.subcategories.all, ...LEDGER],
  "subcategories.archive": [queryKeys.subcategories.all],
  "subcategories.restore": [queryKeys.subcategories.all],
  "subcategories.delete": [queryKeys.subcategories.all, ...LEDGER],
  // Goals feed the dashboard's goals card.
  "goals.create": [queryKeys.goals.all],
  "goals.update": [queryKeys.goals.all],
  "goals.archive": [queryKeys.goals.all],
  "goals.restore": [queryKeys.goals.all],
  // Its contribution transfers stay, as plain transfers.
  "goals.delete": [queryKeys.goals.all, ...LEDGER],
  // A contribution to an account-linked goal is a transfer: balances, transactions and reports move.
  "goalContributions.add": [queryKeys.goalContributions.all, queryKeys.goals.all, ...LEDGER_WRITE],
  "goalContributions.remove": [queryKeys.goalContributions.all, queryKeys.goals.all, ...LEDGER_WRITE],
  // The debt summary is a report.
  "debts.create": [queryKeys.debts.all, queryKeys.reports.all],
  "debts.update": [queryKeys.debts.all, queryKeys.reports.all],
  "debts.archive": [queryKeys.debts.all, queryKeys.reports.all],
  "debts.restore": [queryKeys.debts.all, queryKeys.reports.all],
  // Deletes its payments' transactions and reverses their balance effects.
  "debts.delete": [queryKeys.debts.all, ...LEDGER_WRITE],
  "debtPayments.record": [queryKeys.debtPayments.all, queryKeys.debts.all, ...LEDGER_WRITE],
  "debtPayments.remove": [queryKeys.debtPayments.all, queryKeys.debts.all, ...LEDGER_WRITE],
  // A new code changes no link; the page polls the list until the bot redeems it.
  // `chatHistory.delete` changes nothing the web reads, so it has no entry.
  "chatLinks.unlink": [queryKeys.chatLinks.all],
  "chatLinks.setReadOnly": [queryKeys.chatLinks.all],
  // The bot's username feeds the Telegram link flow (`chatLinks.list`).
  "instance.saveTelegram": [queryKeys.instance.all, queryKeys.chatLinks.all],
  "instance.removeTelegram": [queryKeys.instance.all, queryKeys.chatLinks.all],
  "instance.saveAi": [queryKeys.instance.all],
};

async function invalidateAfter(queryClient: QueryClient, name: MutationName): Promise<void> {
  await Promise.all((INVALIDATES[name] ?? []).map((key) => queryClient.invalidateQueries({ queryKey: key() })));
}

type Input<G extends Group, O extends WriteOp<G>> = RouterInputs[G][O];
type Output<G extends Group, O extends WriteOp<G>> = O extends keyof RouterOutputs[G] ? RouterOutputs[G][O] : never;
export type ApiError = TRPCClientError<AppRouter>;
type Options<G extends Group, O extends WriteOp<G>> = Omit<UseMutationOptions<Output<G, O>, ApiError, Input<G, O>>, "mutationFn" | "mutationKey">;

/**
 * An API write as a React Query mutation: `useApiMutation("accounts", "create")`.
 *
 * - The `Idempotency-Key` comes from `idempotencyLink` (`./trpc.ts`): one per
 *   write, reused while the same input is sent again before a success (React
 *   Query retries, a second click), so the server replays the first write.
 * - On success, invalidates `INVALIDATES[group.op]` before the caller's `onSuccess`.
 *   So does `not_found`: the record is already gone (changed elsewhere), and the
 *   lists still showing it are stale.
 */
export function useApiMutation<G extends Group, O extends WriteOp<G>>(group: G, op: O, options: Options<G, O> = {}) {
  const queryClient = useQueryClient();
  const name = `${String(group)}.${op}` as MutationName;
  const procedure = (trpc as unknown as Record<string, Record<string, { mutationOptions: () => UseMutationOptions<Output<G, O>, ApiError, Input<G, O>> }>>)[
    group as string
  ]![op]!;

  return useMutation<Output<G, O>, ApiError, Input<G, O>>({
    ...procedure.mutationOptions(),
    ...options,
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
