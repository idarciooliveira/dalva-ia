import type { AppRouter } from "@mpf/api/trpc";
import type { QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, httpLink, splitLink, type TRPCLink } from "@trpc/client";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { observable } from "@trpc/server/observable";

import { createIdempotencyKeys } from "./idempotency";

/*
 * tRPC at `/api/trpc` (accounts only, next to the `/api/v1` contract client).
 * Same origin, session cookie. Types come from `apps/api`, type-only: nothing
 * of the server is bundled.
 */

export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type Account = RouterOutputs["accounts"]["get"]["account"];

const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/**
 * One `Idempotency-Key` per write, kept per procedure while the same input is
 * sent again before a success (a React Query retry, a double submit), so the
 * server replays the first write instead of applying it twice. A key set by
 * the caller (`context: { idempotencyKey }`) wins.
 */
export function idempotencyLink(): TRPCLink<AppRouter> {
  const byPath = new Map<string, ReturnType<typeof createIdempotencyKeys>>();
  return () =>
    ({ op, next }) =>
      observable((observer) => {
        if (op.type !== "mutation" || typeof op.context.idempotencyKey === "string") return next(op).subscribe(observer);
        let keys = byPath.get(op.path);
        if (!keys) byPath.set(op.path, (keys = createIdempotencyKeys()));
        const key = keys.keyFor(op.input);
        return next({ ...op, context: { ...op.context, idempotencyKey: key } }).subscribe({
          next: (value) => {
            keys.settled(key);
            observer.next(value);
          },
          error: (error) => observer.error(error),
          complete: () => observer.complete(),
        });
      });
}

const url = "/api/trpc";

export const trpcClient = createTRPCClient<AppRouter>({
  links: [
    idempotencyLink(),
    splitLink({
      condition: (op) => op.type === "query",
      // Reads of one render go out as one request.
      true: httpBatchLink({ url }),
      // Writes one per request: the Idempotency-Key header is per request.
      false: httpLink({
        url,
        headers: ({ op }) => {
          const key = op.context.idempotencyKey;
          return typeof key === "string" ? { [IDEMPOTENCY_KEY_HEADER]: key } : {};
        },
      }),
    }),
  ],
});

let boundQueryClient: QueryClient | undefined;

/** The router's QueryClient, for the options proxy (`getRouter` binds it). */
export function bindTrpcQueryClient(queryClient: QueryClient): void {
  boundQueryClient = queryClient;
}

/** `trpc.accounts.list.queryOptions(input)`, `trpc.accounts.create.mutationOptions()`, `trpc.accounts.pathKey()`. */
export const trpc = createTRPCOptionsProxy<AppRouter>({
  client: trpcClient,
  queryClient: () => {
    if (!boundQueryClient) throw new Error("bindTrpcQueryClient() was not called");
    return boundQueryClient;
  },
});
