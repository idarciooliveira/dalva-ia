import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { authClient, resetUserCache, sessionQuery } from "@/lib/auth-client";

/** The signed-in user: `data` is the user, null when signed out, undefined while loading. */
export function useSession() {
  return useQuery(sessionQuery());
}

/** Signs out, leaves for the landing page and drops the previous user's cached data. */
export function useSignOut() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return useCallback(async () => {
    try {
      await authClient.signOut();
    } finally {
      // Leave the protected layout first, so its queries don't refetch against a dead session.
      await router.navigate({ to: "/" });
      await resetUserCache(queryClient);
    }
  }, [queryClient, router]);
}
