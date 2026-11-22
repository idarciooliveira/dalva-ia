import { ConvexProvider } from "convex/react";
import type { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

import { LegacyBackendError } from "@/lib/api/errors";

/**
 * Pages not moved to the API yet (transactions, transfers, dashboard data, goals,
 * debts, settings) still call Convex hooks. Sign-in now goes through Better Auth,
 * so Convex would never see a user: instead of a live client, their reads and
 * writes fail at once with `LegacyBackendError`, and those pages show their empty
 * or error states. PRs 10-11 move them and delete this file.
 */
const reject = () => Promise.reject(new LegacyBackendError());
const disabledClient = {
  query: reject,
  mutation: reject,
  action: reject,
  watchQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, journal: () => undefined }),
  setAuth: () => {},
  clearAuth: () => {},
  close: () => Promise.resolve(),
} as unknown as ConvexReactClient;

export function LegacyConvexProvider({ children }: { children: ReactNode }) {
  return <ConvexProvider client={disabledClient}>{children}</ConvexProvider>;
}

/** `["convexQuery", ...]` and `["convexAction", ...]` keys from `@convex-dev/react-query`. */
export function isLegacyConvexKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === "convexQuery" || queryKey[0] === "convexAction";
}
