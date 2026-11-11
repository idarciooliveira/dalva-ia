import {
  AUTHORIZATION_HEADER,
  ERROR_STATUS,
  IDEMPOTENCY_KEY_HEADER,
  allRoutes,
  fail,
  idempotencyKeySchema,
  isWriteRoute,
  matchRoute,
  mergeRequestInput,
  ok,
  parseBearerToken,
  validationIssues,
  type ErrorCode,
  type HttpMethod,
} from "@mpf/finance-contract";
import type { FunctionReference } from "convex/server";

import { httpAction, type ActionCtx } from "../../_generated/server";
import { readApiErrorData } from "./errors";
import { implementationFor } from "./registry";
import { verifyUserToken, type FinanceScope } from "./tokens";

/** Every method used by the contract; `http.ts` mounts the router for each. */
export const API_METHODS: HttpMethod[] = [...new Set(allRoutes().map((r) => r.route.method))];

export const MAX_BODY_BYTES = 64 * 1024;
export const REPLAYED_HEADER = "Idempotent-Replayed";

class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function errorResponse(code: ErrorCode, message: string, details?: unknown) {
  const headers: Record<string, string> = code === "unauthorized" ? { "WWW-Authenticate": 'Bearer realm="finance-api"' } : {};
  return json(ERROR_STATUS[code], fail(code, message, details), headers);
}

async function authenticate(request: Request) {
  const token = parseBearerToken(request.headers.get(AUTHORIZATION_HEADER));
  if (!token) throw new HttpError("unauthorized", "Missing bearer token");
  const result = await verifyUserToken(token);
  if (!result.ok) {
    if (result.reason === "misconfigured") {
      console.error("Finance API: FINANCE_API_TOKEN_SECRET is missing or too short");
      throw new HttpError("internal", "Internal error");
    }
    throw new HttpError("unauthorized", result.reason === "expired" ? "Token expired" : "Invalid token");
  }
  return result.claims;
}

export class BodyTooLargeError extends Error {
  override name = "BodyTooLargeError";
}

/**
 * Read a body as UTF-8, stopping (and cancelling the stream) as soon as it
 * passes `maxBytes`. Chunked bodies have no Content-Length, so the header
 * check alone would buffer them whole.
 */
export async function readBodyText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(`Body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError("validation_failed", "Request body too large");
  let text: string;
  try {
    text = await readBodyText(request.body, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new HttpError("validation_failed", "Request body too large");
    throw error;
  }
  if (text.trim() === "") return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError("validation_failed", "Request body is not valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError("validation_failed", "Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** JSON with sorted keys, so the hash ignores key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function handle(ctx: ActionCtx, request: Request): Promise<Response> {
  const claims = await authenticate(request);

  const url = new URL(request.url);
  const match = matchRoute(request.method, url.pathname);
  const implementation = match && implementationFor(match.group, match.op);
  if (!match || !implementation) throw new HttpError("not_found", "Route not found");

  const write = isWriteRoute(match.route);
  const required: FinanceScope = write ? "finance:write" : "finance:read";
  if (!claims.scopes.includes(required)) throw new HttpError("forbidden", `Token lacks the ${required} scope`);

  let idempotencyKey: string | undefined;
  if (write) {
    const parsedKey = idempotencyKeySchema.safeParse(request.headers.get(IDEMPOTENCY_KEY_HEADER) ?? undefined);
    if (!parsedKey.success) {
      throw new HttpError("validation_failed", `Missing or invalid ${IDEMPOTENCY_KEY_HEADER} header`, {
        issues: [{ path: IDEMPOTENCY_KEY_HEADER, message: parsedKey.error.issues[0]?.message ?? "Required" }],
      });
    }
    idempotencyKey = parsedKey.data;
  }

  const source = write ? await readJsonBody(request) : url.searchParams;
  const parsed = match.route.request.safeParse(mergeRequestInput(match, source));
  if (!parsed.success) {
    throw new HttpError("validation_failed", "Request validation failed", validationIssues(parsed.error));
  }

  const userId = claims.sub;
  if (!write) {
    const data: unknown = await ctx.runQuery(implementation as FunctionReference<"query", "internal">, {
      userId,
      input: parsed.data,
    });
    return json(200, ok(data));
  }

  const requestHash = await sha256Hex(canonicalJson({ operation: match.name, input: parsed.data }));
  const result = (await ctx.runMutation(implementation as FunctionReference<"mutation", "internal">, {
    userId,
    input: parsed.data,
    idempotencyKey,
    requestHash,
  })) as { replayed: boolean; data: unknown };
  return json(200, ok(result.data), result.replayed ? { [REPLAYED_HEADER]: "true" } : {});
}

/** Single httpAction behind every `/api/v1/*` route. */
export const financeApi = httpAction(async (ctx, request) => {
  try {
    return await handle(ctx, request);
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error.code, error.message, error.details);
    const data = readApiErrorData(error);
    if (data) return errorResponse(data.code, data.message, data.details);
    console.error("Finance API: unhandled error", error);
    return errorResponse("internal", "Internal error");
  }
});
