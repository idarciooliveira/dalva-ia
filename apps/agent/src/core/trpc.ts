import { FinanceApiError, type FinanceApiErrorCode } from "@mpf/finance-contract";
import type { AppRouter } from "@mpf/api/trpc";
import { createTRPCClient, httpLink, type TRPCClient, TRPCClientError } from "@trpc/client";
import type { inferRouterOutputs } from "@trpc/server";

/** The `/api/trpc` client for one user token. Types only from `@mpf/api`. */
export type FinanceTrpc = TRPCClient<AppRouter>;
export type Account = inferRouterOutputs<AppRouter>["accounts"]["get"]["account"];

/**
 * Writes take their `Idempotency-Key` from the call:
 * `trpc.accounts.adjust.mutate(input, { context: { idempotencyKey } })`.
 */
export function createFinanceTrpc(options: { baseUrl: string; token: string; fetch: typeof fetch }): FinanceTrpc {
  return createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: `${options.baseUrl.replace(/\/+$/, "")}/api/trpc`,
        fetch: options.fetch,
        headers: ({ op }) => {
          const key = op.context.idempotencyKey;
          return { Authorization: `Bearer ${options.token}`, ...(typeof key === "string" ? { "Idempotency-Key": key } : {}) };
        },
      }),
    ],
  });
}

/**
 * Await a tRPC call; a failure becomes the `FinanceApiError` the `/api/v1`
 * client would have thrown, so the agent's error handling (built on the v1
 * codes: fatal, ambiguous, conflict reasons) applies as is.
 */
export async function viaTrpc<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw toFinanceError(error);
  }
}

function toFinanceError(error: unknown): unknown {
  if (!(error instanceof TRPCClientError)) return error;
  const data = error.data as { apiCode?: FinanceApiErrorCode; httpStatus?: number; details?: unknown } | undefined;
  if (data?.apiCode) return new FinanceApiError(data.apiCode, error.message, data.httpStatus ?? null, data.details, { cause: error });
  const causeName = (error.cause as { name?: unknown } | undefined)?.name;
  if (causeName === "TimeoutError") return new FinanceApiError("timeout", "Request timed out", null, { causeName }, { cause: error });
  if (causeName === "AbortError") return new FinanceApiError("aborted", "Request aborted", null, { causeName }, { cause: error });
  const response = error.meta?.response as Response | undefined;
  if (response) return new FinanceApiError("invalid_response", error.message, response.status, undefined, { cause: error });
  return new FinanceApiError("network_error", "Request failed", null, undefined, { cause: error });
}
