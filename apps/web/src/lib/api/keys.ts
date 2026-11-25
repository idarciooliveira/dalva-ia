import { trpc, type RouterInputs } from "./trpc";

/**
 * Query keys. `all` keys are invalidation prefixes: tRPC keys start with the
 * procedure path (`[["accounts", "list"], ...]`), so a router's `pathKey()`
 * covers every query of that router.
 */
export const queryKeys = {
  session: () => ["session"] as const,
  profile: () => trpc.profile.get.queryKey(),
  accounts: {
    all: () => trpc.accounts.pathKey(),
    list: (input: RouterInputs["accounts"]["list"]) => trpc.accounts.list.queryKey(input),
  },
  categories: {
    all: () => trpc.categories.pathKey(),
    list: (input: RouterInputs["categories"]["list"]) => trpc.categories.list.queryKey(input),
    defaults: () => trpc.categories.defaults.queryKey(),
  },
  subcategories: {
    all: () => trpc.subcategories.pathKey(),
    list: (input: RouterInputs["subcategories"]["list"]) => trpc.subcategories.list.queryKey(input),
  },
  goals: {
    all: () => trpc.goals.pathKey(),
    list: (input: RouterInputs["goals"]["list"]) => trpc.goals.list.queryKey(input),
  },
  // Own routers: deleting a goal or debt must not refetch its (gone) history.
  goalContributions: {
    all: () => trpc.goalContributions.pathKey(),
    list: (goalId: string) => trpc.goalContributions.list.queryKey({ goalId }),
  },
  debts: {
    all: () => trpc.debts.pathKey(),
    list: (input: RouterInputs["debts"]["list"]) => trpc.debts.list.queryKey(input),
  },
  debtPayments: {
    all: () => trpc.debtPayments.pathKey(),
    list: (debtId: string) => trpc.debtPayments.list.queryKey({ debtId }),
  },
  reports: {
    all: () => trpc.reports.pathKey(),
    debtSummary: () => trpc.reports.debtSummary.queryKey(),
  },
  chatLinks: {
    all: () => trpc.chatLinks.pathKey(),
  },
  instance: {
    all: () => trpc.instance.pathKey(),
  },
  transactions: { all: () => trpc.transactions.pathKey() },
  transfers: { all: () => trpc.transfers.pathKey() },
};
