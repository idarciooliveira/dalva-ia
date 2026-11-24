import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { routeTree } from "./routeTree.gen";

import { queryKeys } from "@/lib/api/keys";
import { isApiError, isTransientError } from "@/lib/api/errors";
import { resetDataOnUserChange } from "@/lib/auth-client";

export function getRouter() {
  // A 401 from the API means the session ended (expired, signed out elsewhere):
  // re-read it and the auth guard sends the user to /login.
  const onError = (error: unknown) => {
    if (isApiError(error, "unauthorized")) void queryClient.invalidateQueries({ queryKey: queryKeys.session() });
  };

  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        // Every query sets its own queryFn.
        queryFn: ({ queryKey }) => {
          throw new Error(`No queryFn for ${JSON.stringify(queryKey)}`);
        },
        // No live updates until SSE (after cutover): writes invalidate what they change,
        // and anything older than this refetches on mount and window focus.
        staleTime: 30_000,
        retry: (failureCount, error) => failureCount < 2 && isTransientError(error),
      },
      mutations: {
        // Safe: a retry sends the same Idempotency-Key, so the server replays instead of writing twice.
        retry: (failureCount, error) =>
          failureCount < 1 && (isApiError(error, "network_error") || isApiError(error, "timeout")),
      },
    },
  });

  // No query of one user may serve another (sign out, or a sign-in in another tab).
  if (typeof window !== "undefined") resetDataOnUserChange(queryClient);

  const router = createTanStackRouter({
    routeTree,
    defaultPreload: "intent",
    context: { queryClient },
    scrollRestoration: true,
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
