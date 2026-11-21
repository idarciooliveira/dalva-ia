import { createAuthClient } from "better-auth/client";
import { queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/api/keys";

/**
 * Better Auth on the same origin (`/api/auth`, proxied to apps/api). The session
 * is an httpOnly cookie; nothing is stored in JS. The server rendering of the
 * SPA shell never calls it, so the origin fallback only satisfies the constructor.
 */
export const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? "http://localhost" : window.location.origin,
  basePath: "/api/auth",
});

export interface AuthFailure {
  status: number;
  code?: string;
  message?: string;
}

export class SessionError extends Error {
  override name = "SessionError";
  constructor(readonly status: number) {
    super(`Session check failed (HTTP ${status})`);
  }
}

export type SessionUser = { id: string; name: string; email: string };

/** The signed-in user, or null. Throws when the server can't say (down, 5xx), so callers show an error. */
export const sessionQuery = () =>
  queryOptions({
    queryKey: queryKeys.session(),
    queryFn: async ({ signal }): Promise<SessionUser | null> => {
      const { data, error } = await authClient.getSession({ fetchOptions: { signal } });
      if (error) {
        if (error.status === 401) return null;
        throw new SessionError(error.status);
      }
      if (!data) return null;
      return { id: data.user.id, name: data.user.name, email: data.user.email };
    },
    staleTime: 30_000,
    // Another tab may have signed in as someone else (shared cookie): check on every focus.
    refetchOnWindowFocus: "always",
  });

const isSessionKey = (queryKey: readonly unknown[]) => queryKey[0] === queryKeys.session()[0];

/** Reset every cached query but the session: data refetches for whoever is signed in now. */
export function resetUserData(queryClient: QueryClient): Promise<void> {
  return queryClient.resetQueries({ predicate: (query) => !isSessionKey(query.queryKey) });
}

/**
 * Drop everything cached for the previous user (another account may have used
 * this tab) and re-read the session. Call after sign in, sign up and sign out.
 */
export async function resetUserCache(queryClient: QueryClient): Promise<SessionUser | null> {
  await resetUserData(queryClient);
  await queryClient.invalidateQueries({ queryKey: queryKeys.session() });
  return queryClient.fetchQuery(sessionQuery());
}

/**
 * Whenever the session's user changes (signed out, or another account signed in
 * from another tab, which shares the cookie), reset the previous user's data.
 * Returns the unsubscribe function.
 */
export function resetDataOnUserChange(queryClient: QueryClient): () => void {
  let lastUserId: string | null | undefined;
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || !isSessionKey(event.query.queryKey)) return;
    const user = event.query.state.data as SessionUser | null | undefined;
    if (user === undefined) return;
    const userId = user?.id ?? null;
    const changed = lastUserId !== undefined && userId !== lastUserId;
    lastUserId = userId;
    // Outside the cache's notification.
    if (changed) queueMicrotask(() => void resetUserData(queryClient));
  });
}
