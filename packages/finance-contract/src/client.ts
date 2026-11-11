import { z } from "zod";

import {
  API_BASE_PATH,
  AUTHORIZATION_HEADER,
  bearerAuthorization,
  errorCodeSchema,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
  successEnvelope,
  validationIssues,
} from "./envelope";
import type { ErrorCode } from "./envelope";
import { buildRequestParts, requiresIdempotencyKey, routes } from "./routes";
import type { RouteAuth, RouteDef, RouteInput, RouteOutput, ServiceRoutes, UserRoutes } from "./routes";

/**
 * Server error codes plus the ones raised locally by the client:
 * `invalid_response` (reply broke the contract), `network_error` (no reply),
 * `aborted` (the caller's signal was aborted) and `timeout` (the signal's reason was a `TimeoutError`).
 */
export type FinanceApiErrorCode = ErrorCode | "invalid_response" | "network_error" | "aborted" | "timeout";

export class FinanceApiError extends Error {
  override name = "FinanceApiError";
  readonly idempotencyKey: string | undefined;

  constructor(
    readonly code: FinanceApiErrorCode,
    message: string,
    /** HTTP status, or null when no HTTP response was involved (bad input, network). */
    readonly status: number | null,
    readonly details?: unknown,
    options?: {
      cause?: unknown;
      /** Key sent with a write. Reuse it to retry safely after `network_error`, `aborted` or `timeout`. */
      idempotencyKey?: string;
    },
  ) {
    super(message, { cause: options?.cause });
    this.idempotencyKey = options?.idempotencyKey;
  }
}

function nameOf(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string"
    ? (value as { name: string }).name
    : undefined;
}

/** Looser than `errorEnvelopeSchema`: lets the client keep the message of codes it does not know yet. */
const looseErrorEnvelope = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

export interface CallOptions {
  /** User-route writes only. Reuse the same key to safely retry a request; generated when omitted. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface FinanceClientOptions {
  /** Origin only, e.g. `https://finance.example.com`. `/api/v1` is appended. */
  baseUrl: string;
  /** Called before every request; return the user-scoped bearer token. */
  getToken: () => string | Promise<string>;
  fetch?: typeof fetch;
  /** Override idempotency key generation (defaults to `crypto.randomUUID()`). */
  generateIdempotencyKey?: () => string;
}

export interface FinanceServiceClientOptions {
  /** Origin only, e.g. `https://finance.example.com`. `/api/v1` is appended. */
  baseUrl: string;
  /** The service key (`FINANCE_API_SERVICE_KEY`). Server-side only: never ship it to a browser. */
  getServiceKey: () => string | Promise<string>;
  fetch?: typeof fetch;
}

type OperationFn<R extends RouteDef> = {} extends RouteInput<R>
  ? (input?: RouteInput<R>, options?: CallOptions) => Promise<RouteOutput<R>>
  : (input: RouteInput<R>, options?: CallOptions) => Promise<RouteOutput<R>>;

type ClientFor<M> = {
  [G in keyof M]: { [O in keyof M[G]]: M[G][O] extends RouteDef ? OperationFn<M[G][O]> : never };
};

/** One method per user operation: `client.transactions.search({ ... })`. */
export type FinanceClient = ClientFor<UserRoutes>;

/** One method per service operation: `service.channelIdentities.resolve({ ... })`. */
export type FinanceServiceClient = ClientFor<ServiceRoutes>;

/** `crypto.randomUUID()` where available; random hex otherwise (e.g. insecure browser contexts). */
function defaultIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface TransportOptions {
  baseUrl: string;
  getCredential: () => string | Promise<string>;
  fetch?: typeof fetch;
  generateIdempotencyKey?: () => string;
}

/** Only the routes for `auth`: a user client has no service methods and vice versa. */
function buildClient(auth: RouteAuth, options: TransportOptions): unknown {
  const baseUrl = options.baseUrl.replace(/\/+$/, "") + API_BASE_PATH;
  const doFetch: typeof fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const newKey = options.generateIdempotencyKey ?? defaultIdempotencyKey;

  async function call(route: RouteDef, rawInput: unknown, callOptions: CallOptions = {}): Promise<unknown> {
    const parsed = route.request.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new FinanceApiError("validation_failed", "Invalid request", null, validationIssues(parsed.error));
    }

    let idempotencyKey: string | undefined;
    const apiError = (
      code: FinanceApiErrorCode,
      message: string,
      status: number | null,
      details?: unknown,
      cause?: unknown,
    ) => new FinanceApiError(code, message, status, details, { cause, idempotencyKey });

    const headers = new Headers({ Accept: "application/json" });
    const token = await options.getCredential();
    try {
      headers.set(AUTHORIZATION_HEADER, bearerAuthorization(token));
    } catch (error) {
      throw apiError("validation_failed", "Token is not a valid header value", null, undefined, error);
    }

    const { path, query, body } = buildRequestParts(route, parsed.data as Record<string, unknown>);
    if (requiresIdempotencyKey(route)) {
      const key = callOptions.idempotencyKey ?? newKey();
      const keyCheck = idempotencyKeySchema.safeParse(key);
      if (!keyCheck.success) {
        throw apiError("validation_failed", "Invalid idempotency key", null, validationIssues(keyCheck.error));
      }
      idempotencyKey = key;
      headers.set(IDEMPOTENCY_KEY_HEADER, key);
    }
    if (body !== undefined) headers.set("Content-Type", "application/json");

    let response: Response;
    let text: string;
    try {
      response = await doFetch(`${baseUrl}${path}${query ? `?${query}` : ""}`, {
        method: route.method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: callOptions.signal,
      });
      text = await response.text();
    } catch (error) {
      // Never touch the caught error: it can be shared (one `signal.reason` for many calls) or frozen.
      // Each call gets its own FinanceApiError carrying its own key, with the original as `cause`.
      const signal = callOptions.signal;
      if (signal?.aborted) {
        const causeName = nameOf(error) ?? nameOf(signal.reason);
        const timedOut = causeName === "TimeoutError" || nameOf(signal.reason) === "TimeoutError";
        throw apiError(
          timedOut ? "timeout" : "aborted",
          timedOut ? "Request timed out" : "Request aborted",
          null,
          { causeName },
          error,
        );
      }
      throw apiError("network_error", "Request failed", null, undefined, error);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }

    // An error envelope wins regardless of HTTP status.
    const failure = looseErrorEnvelope.safeParse(json);
    if (failure.success) {
      const { code, message, details } = failure.data.error;
      const known = errorCodeSchema.safeParse(code);
      if (known.success) throw apiError(known.data, message, response.status, details);
      // A code this client predates: keep the server's message and the raw code.
      throw apiError("invalid_response", message, response.status, { serverCode: code, details });
    }

    if (!response.ok) {
      throw apiError("invalid_response", `HTTP ${response.status} without an error envelope`, response.status);
    }

    const envelope = successEnvelope(route.response).safeParse(json);
    if (!envelope.success) {
      throw apiError(
        "invalid_response",
        "Response did not match the contract",
        response.status,
        validationIssues(envelope.error),
      );
    }
    return envelope.data.data;
  }

  const groups = Object.entries(routes as Record<string, Record<string, RouteDef>>).filter(([, ops]) =>
    Object.values(ops).every((route) => route.auth === auth),
  );
  return Object.fromEntries(
    groups.map(([group, ops]) => [
      group,
      Object.fromEntries(
        Object.entries(ops).map(([op, route]) => [
          op,
          (input?: unknown, callOptions?: CallOptions) => call(route, input, callOptions),
        ]),
      ),
    ]),
  );
}

/** Client for the user routes, authenticated with a user token. */
export function createFinanceClient(options: FinanceClientOptions): FinanceClient {
  return buildClient("user", {
    baseUrl: options.baseUrl,
    getCredential: options.getToken,
    fetch: options.fetch,
    generateIdempotencyKey: options.generateIdempotencyKey,
  }) as FinanceClient;
}

/**
 * Client for the service routes (channel linking), authenticated with the
 * service key. Calls take no `Idempotency-Key`: `redeem` is single-use, so
 * after an ambiguous failure call `resolve` to see whether the link exists.
 */
export function createFinanceServiceClient(options: FinanceServiceClientOptions): FinanceServiceClient {
  return buildClient("service", { baseUrl: options.baseUrl, getCredential: options.getServiceKey, fetch: options.fetch }) as FinanceServiceClient;
}
