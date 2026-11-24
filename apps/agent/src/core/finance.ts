/**
 * The agent's API clients: tRPC (`/api/trpc`), typed from `apps/api`'s
 * `AppRouter` (type-only). One client per credential: the service key, or a
 * user token minted for a linked chat. Failures surface as `FinanceError`,
 * the API's error code plus what the client concludes when no answer came back.
 */
import type { AppRouter } from "@mpf/api/trpc";
import { createTRPCClient, httpLink, type TRPCClient, TRPCClientError } from "@trpc/client";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

export type FinanceClient = TRPCClient<AppRouter>;
export type FinanceInputs = inferRouterInputs<AppRouter>;
export type FinanceOutputs = inferRouterOutputs<AppRouter>;

export type FinanceErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "rate_limited"
  | "internal"
  /** The answer wasn't the API's (a proxy error page). */
  | "invalid_response"
  /** No answer. */
  | "network_error"
  /** The caller's signal was aborted. */
  | "aborted"
  /** The per-request timeout fired. */
  | "timeout";

export class FinanceError extends Error {
  override name = "FinanceError";
  constructor(
    readonly code: FinanceErrorCode,
    message: string,
    /** HTTP status, or null when no response came back. */
    readonly status: number | null,
    readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function toFinanceError(error: unknown): unknown {
  if (!(error instanceof TRPCClientError)) return error;
  const data = error.data as { apiCode?: FinanceErrorCode; httpStatus?: number; details?: unknown } | undefined;
  if (data?.apiCode) return new FinanceError(data.apiCode, error.message, data.httpStatus ?? null, data.details, { cause: error });
  const causeName = (error.cause as { name?: unknown } | undefined)?.name;
  if (causeName === "TimeoutError") return new FinanceError("timeout", "Request timed out", null, { causeName }, { cause: error });
  if (causeName === "AbortError") return new FinanceError("aborted", "Request aborted", null, { causeName }, { cause: error });
  const response = error.meta?.response as Response | undefined;
  if (response) return new FinanceError("invalid_response", error.message, response.status, undefined, { cause: error });
  return new FinanceError("network_error", "Request failed", null, undefined, { cause: error });
}

/** The client with every call's failure turned into a `FinanceError`. */
function withFinanceErrors<T extends object>(target: T): T {
  return new Proxy(target, {
    get: (object, key) => {
      const value = Reflect.get(object, key) as unknown;
      return typeof value === "function" || (typeof value === "object" && value !== null) ? withFinanceErrors(value as object) : value;
    },
    apply: async (fn, thisArg, args) => {
      try {
        return await Reflect.apply(fn as (...a: unknown[]) => unknown, thisArg, args);
      } catch (error) {
        throw toFinanceError(error);
      }
    },
  });
}

export interface FinanceClients {
  service: FinanceClient;
  /** User client for a token minted by `channelIdentities.resolve`. */
  forToken(token: string): FinanceClient;
}

export interface FinanceClientsOptions {
  baseUrl: string;
  serviceKey: string;
  fetch?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export function createFinanceClients(options: FinanceClientsOptions): FinanceClients {
  const baseFetch: typeof fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const timedFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    baseFetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    })) as typeof fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/api/trpc`;

  /**
   * Writes take their `Idempotency-Key` from the call:
   * `finance.transactions.create.mutate(input, { context: { idempotencyKey } })`.
   */
  const clientFor = (credential: string): FinanceClient =>
    withFinanceErrors(
      createTRPCClient<AppRouter>({
        links: [
          httpLink({
            url,
            fetch: timedFetch,
            headers: ({ op }) => {
              const key = op.context.idempotencyKey;
              return { Authorization: `Bearer ${credential}`, ...(typeof key === "string" ? { "Idempotency-Key": key } : {}) };
            },
          }),
        ],
      }),
    );

  return { service: clientFor(options.serviceKey), forToken: clientFor };
}

export function isFinanceError(error: unknown, ...codes: FinanceErrorCode[]): error is FinanceError {
  return error instanceof FinanceError && (codes.length === 0 || codes.includes(error.code));
}

/* Records as the agent reads them. */
export type Account = FinanceOutputs["accounts"]["get"]["account"];
export type Transaction = FinanceOutputs["transactions"]["get"]["transaction"];
export type Category = FinanceOutputs["categories"]["list"]["items"][number];
export type Subcategory = FinanceOutputs["subcategories"]["list"]["items"][number];
export type AgentSession = FinanceOutputs["agentSessions"]["current"]["session"];
export type AgentMessage = FinanceOutputs["agentMessages"]["list"]["items"][number];
export type AgentPendingAction = FinanceOutputs["agentPendingActions"]["get"]["action"];
export type AgentActionOperation = AgentPendingAction["operation"];
export type AgentActionStatus = AgentPendingAction["status"];
export type Channel = AgentSession["channel"];
