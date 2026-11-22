import type { RouteInput, UserRoutes } from "@mpf/finance-contract";

/**
 * Query keys for the API. Every API key starts with "api" so it never collides
 * with the legacy `["convexQuery", ...]` keys; `all` keys are invalidation prefixes.
 */
export const queryKeys = {
  session: () => ["session"] as const,
  profile: () => ["api", "profile"] as const,
  accounts: {
    all: () => ["api", "accounts"] as const,
    list: (input: RouteInput<UserRoutes["accounts"]["list"]>) => ["api", "accounts", "list", input] as const,
  },
  categories: {
    all: () => ["api", "categories"] as const,
    list: (input: RouteInput<UserRoutes["categories"]["list"]>) => ["api", "categories", "list", input] as const,
    defaults: () => ["api", "categories", "defaults"] as const,
  },
  subcategories: {
    all: () => ["api", "subcategories"] as const,
    list: (input: RouteInput<UserRoutes["subcategories"]["list"]>) => ["api", "subcategories", "list", input] as const,
  },
  goals: {
    all: () => ["api", "goals"] as const,
    list: (input: RouteInput<UserRoutes["goals"]["list"]>) => ["api", "goals", "list", input] as const,
  },
  // Not under "goals"/"debts": deleting a goal or debt must not refetch its (gone) history.
  goalContributions: {
    all: () => ["api", "goalContributions"] as const,
    list: (goalId: string) => ["api", "goalContributions", goalId] as const,
  },
  debts: {
    all: () => ["api", "debts"] as const,
    list: (input: RouteInput<UserRoutes["debts"]["list"]>) => ["api", "debts", "list", input] as const,
  },
  debtPayments: {
    all: () => ["api", "debtPayments"] as const,
    list: (debtId: string) => ["api", "debtPayments", debtId] as const,
  },
  reports: {
    all: () => ["api", "reports"] as const,
    debtSummary: () => ["api", "reports", "debtSummary"] as const,
  },
  chatLinks: {
    all: () => ["api", "chatLinks"] as const,
  },
  // Read by pages that move in PR 10; listed now so writes here already invalidate them.
  transactions: { all: () => ["api", "transactions"] as const },
};
