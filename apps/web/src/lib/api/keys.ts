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
  // Read by pages that move in PRs 10-11; listed now so writes here already invalidate them.
  transactions: { all: () => ["api", "transactions"] as const },
  reports: { all: () => ["api", "reports"] as const },
  goals: { all: () => ["api", "goals"] as const },
  debts: { all: () => ["api", "debts"] as const },
};
