import { API_BASE_PATH, AUTHORIZATION_HEADER, bearerAuthorization, errorEnvelopeSchema, IDEMPOTENCY_KEY_HEADER, idempotencyKeySchema, successEnvelope, validationIssues } from "./envelope";
import type { ErrorCode } from "./envelope";
import { buildRequestParts, isWriteRoute, routes } from "./routes";
import type { RouteDef, RouteInput, RouteOutput, Routes } from "./routes";

/** Server error codes plus two raised locally by the client. */
export type FinanceApiErrorCode = ErrorCode | "invalid_response" | "network_error";

export class FinanceApiError extends Error {
  override name = "FinanceApiError";

  constructor(
    readonly code: FinanceApiErrorCode,
    message: string,
    /** HTTP status, or null when no HTTP response was involved (bad input, network). */
    readonly status: number | null,
    readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

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

export function createFinanceClient(options: FinanceClientOptions): FinanceClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "") + API_BASE_PATH;
  const doFetch: typeof fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const newKey = options.generateIdempotencyKey ?? (() => crypto.randomUUID());

  async function call(route: RouteDef, rawInput: unknown, callOptions: CallOptions = {}): Promise<unknown> {
    const parsed = route.request.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new FinanceApiError("validation_failed", "Invalid request", null, validationIssues(parsed.error));
    }

    const headers = new Headers({ Accept: "application/json" });
    headers.set(AUTHORIZATION_HEADER, bearerAuthorization(await options.getToken()));

    const { path, query, body } = buildRequestParts(route, parsed.data as Record<string, unknown>);
    if (isWriteRoute(route)) {
      const key = callOptions.idempotencyKey ?? newKey();
      const keyCheck = idempotencyKeySchema.safeParse(key);
      if (!keyCheck.success) {
        throw new FinanceApiError("validation_failed", "Invalid idempotency key", null, validationIssues(keyCheck.error));
      }
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
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new FinanceApiError("network_error", "Request failed", null, undefined, { cause: error });
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }

    if (response.ok) {
      const envelope = successEnvelope(route.response).safeParse(json);
      if (!envelope.success) {
        throw new FinanceApiError(
          "invalid_response",
          "Response did not match the contract",
          response.status,
          validationIssues(envelope.error),
        );
      }
      return envelope.data.data;
    }

    const failure = errorEnvelopeSchema.safeParse(json);
    if (!failure.success) {
      throw new FinanceApiError("invalid_response", `HTTP ${response.status} without an error envelope`, response.status);
    }
    const { code, message, details } = failure.data.error;
    throw new FinanceApiError(code, message, response.status, details);
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
