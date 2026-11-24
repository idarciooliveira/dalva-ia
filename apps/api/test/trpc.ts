/**
 * Helpers for `/api/trpc` tests: the vanilla tRPC client calling the app
 * in-process (as the agent does), and error assertions on the v1 error code.
 */
import { randomUUID } from "node:crypto";

import { createTRPCClient, httpBatchLink, httpLink, splitLink, TRPCClientError } from "@trpc/client";
import { expect } from "vitest";

import type { ApiErrorCode, AppRouter } from "../src/trpc/router";
import { inProcess, type TestApp } from "./api";
import { TEST_PUBLIC_URL } from "./app";

const URL = "https://finance.test/api/trpc";

export interface TrpcClientOptions {
  token?: string;
  cookie?: string;
  /** Default: a new key per mutation, unless the call passes `context.idempotencyKey`. */
  idempotencyKey?: string | null;
  /** Batch queries into one request (as the web app does). */
  batch?: boolean;
}

/** A tRPC client for `app`. Mutations read `context: { idempotencyKey }`; `null` sends none. */
export function trpcFor(app: TestApp, options: TrpcClientOptions = {}) {
  const fetch = inProcess(app);
  const auth = {
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.cookie ? { cookie: options.cookie, origin: TEST_PUBLIC_URL } : {}),
  };
  const single = httpLink({
    url: URL,
    fetch,
    headers: ({ op }) => {
      if (op.type !== "mutation") return auth;
      const fromContext = op.context.idempotencyKey as string | null | undefined;
      const key = fromContext !== undefined ? fromContext : options.idempotencyKey !== undefined ? options.idempotencyKey : randomUUID();
      return key === null ? auth : { ...auth, "idempotency-key": key };
    },
  });
  return createTRPCClient<AppRouter>({
    links: options.batch ? [splitLink({ condition: (op) => op.type === "query", true: httpBatchLink({ url: URL, fetch, headers: auth }), false: single })] : [single],
  });
}

export type TrpcError = TRPCClientError<AppRouter>;

/** Await a call that must fail with the v1 error `code` (and HTTP `status`). */
export async function expectTrpcError(promise: Promise<unknown>, code: ApiErrorCode, status?: number): Promise<TrpcError> {
  const error = await promise.then(
    () => {
      throw new Error(`Expected ${code}, but the call succeeded`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCClientError);
  const trpcError = error as TrpcError;
  expect({ code: trpcError.data?.apiCode, message: trpcError.message }).toMatchObject({ code });
  if (status !== undefined) expect(trpcError.data?.httpStatus).toBe(status);
  return trpcError;
}

/** Raw POST of a mutation, for what the typed client would refuse to send. */
export async function rawMutation(app: TestApp, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await app.request(`/api/trpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: (await response.json()) as { result?: { data: unknown }; error?: { message: string; data: { apiCode: string; details?: unknown } } } };
}
