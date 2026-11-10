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
import { buildRequestParts, isWriteRoute, routes } from "./routes";
import type { RouteDef, RouteInput, RouteOutput, Routes } from "./routes";

/** Server error codes plus two raised locally by the client. */
export type FinanceApiErrorCode = ErrorCode | "invalid_response" | "network_error";

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
      /** Key sent with a write. Reuse it to retry safely after a `network_error`. */
      idempotencyKey?: string;
    },
  ) {
    super(message, { cause: options?.cause });
    this.idempotencyKey = options?.idempotencyKey;
  }
}

/** Looser than `errorEnvelopeSchema`: lets the client keep the message of codes it does not know yet. */
const looseErrorEnvelope = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

export interface CallOptions {
  /** Writes only. Reuse the same key to safely retry a request; generated when omitted. */
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

type OperationFn<R extends RouteDef> = {} extends RouteInput<R>
  ? (input?: RouteInput<R>, options?: CallOptions) => Promise<RouteOutput<R>>
  : (input: RouteInput<R>, options?: CallOptions) => Promise<RouteOutput<R>>;

/** One method per operation: `client.transactions.search({ ... })`. */
export type FinanceClient = {
  [G in keyof Routes]: { [O in keyof Routes[G]]: Routes[G][O] extends RouteDef ? OperationFn<Routes[G][O]> : never };
};

/** `crypto.randomUUID()` where available; random hex otherwise (e.g. insecure browser contexts). */
function defaultIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createFinanceClient(options: FinanceClientOptions): FinanceClient {
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
    const token = await options.getToken();
    try {
      headers.set(AUTHORIZATION_HEADER, bearerAuthorization(token));
    } catch (error) {
      throw apiError("validation_failed", "Token is not a valid header value", null, undefined, error);
    }

    const { path, query, body } = buildRequestParts(route, parsed.data as Record<string, unknown>);
    if (isWriteRoute(route)) {
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
      // Caller-initiated cancellation (AbortController or AbortSignal.timeout) is not a network failure.
      // The key is attached to it so an ambiguous write (timed out after the server committed) can be retried.
      if (callOptions.signal?.aborted) {
        if (idempotencyKey !== undefined && typeof error === "object" && error !== null) {
          Object.assign(error, { idempotencyKey });
        }
        throw error;
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

  return Object.fromEntries(
    Object.entries(routes).map(([group, ops]) => [
      group,
      Object.fromEntries(
        Object.entries(ops as Record<string, RouteDef>).map(([op, route]) => [
          op,
          (input?: unknown, callOptions?: CallOptions) => call(route, input, callOptions),
        ]),
      ),
    ]),
  ) as unknown as FinanceClient;
}
