/**
 * The contract router: one handler for every `/api/v1/*` request, driven by
 * the `@mpf/finance-contract` route map. Same semantics as the Convex router
 * (`packages/backend/convex/api/v1/router.ts`):
 *
 * (principal middleware: a credential that is there but invalid is 401 on any
 * path) → match the route (else the next handler, 404) → credential of the
 * route's kind (401) → implemented (404) → scope, web-only, chat identity
 * (403) → `Idempotency-Key` on finance writes (400) → body (64 KiB, JSON
 * object) and request schema (400) → handler in a transaction →
 * `{ ok: true, data }`. A `DomainError` becomes its error envelope; anything
 * else is a logged 500 that says nothing about the cause.
 *
 * Service routes (the agent's service key) take the same path minus the user
 * checks: credential (401) → implemented (404) → body and schema (400) →
 * handler in a transaction. Agent-store routes take no `Idempotency-Key`, and
 * their handlers may commit and still answer with an error (`commitThenFail`).
 */
import {
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
  isWriteRoute,
  matchRoute,
  mergeRequestInput,
  ok,
  requiredScope,
  requiresIdempotencyKey,
  type RouteMatch,
  type TokenScope,
  validationIssues,
} from "@mpf/finance-contract";
import type { Context, MiddlewareHandler } from "hono";

import type { UserTokens } from "../auth/tokens";
import type { Database } from "../db/client";
import { readTx, sqlState, type Tx, withTx } from "../db/tx";
import { channelTokenProblem } from "../domain/channelLinks";
import { DomainError } from "../domain/errors";
import { MoneyRangeError } from "../domain/money";
import type { Logger } from "../log";
import { errorResponse } from "./errors";
import { claimKey, type IdempotencyRecord, requestHash, storeResponse } from "./idempotency";
import { CommittedFailure, type Operations, operationFor, type ServiceOperations, serviceOperationFor } from "./operation";
import type { AppEnv, UserPrincipal } from "./principal";

export const MAX_BODY_BYTES = 64 * 1024;
export const REPLAYED_HEADER = "Idempotent-Replayed";
/** character_not_in_repertoire (NUL in `text`), untranslatable_character (`\u0000` in `jsonb`). */
const UNSTORABLE_TEXT = new Set(["22021", "22P05"]);
/** datetime_field_overflow: a date the contract accepts but Postgres doesn't (year 0000). */
const DATE_OUT_OF_RANGE = "22008";

export interface RouterOptions {
  db: Database;
  logger: Logger;
  operations: Operations;
  serviceOperations: ServiceOperations;
  /** For service handlers that mint user tokens (`channelIdentities.resolve`). */
  tokens: UserTokens;
}

/**
 * Middleware on `/api/v1/*`. A request that matches no contract route goes on
 * to the next handler (and the app's 404 envelope when there is none).
 */
export function contractRouter(options: RouterOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const match = matchRoute(c.req.method, url.pathname);
    if (!match) return await next();
    try {
      return await handle(c, url, match, options);
    } catch (error) {
      if (error instanceof DomainError) return errorResponse(c, error.code, error.message, error.details);
      // Text the contract allows but Postgres can't store (a NUL character): the client's input, not a server fault.
      if (UNSTORABLE_TEXT.has(sqlState(error) ?? "")) {
        return errorResponse(c, "validation_failed", "Text contains characters that can't be stored");
      }
      if (sqlState(error) === DATE_OUT_OF_RANGE) return errorResponse(c, "validation_failed", "Date out of range");
      // A stored amount or total the contract can't express (past the safe integer range in ISO minor units).
      if (error instanceof MoneyRangeError) return errorResponse(c, "conflict", "Amount out of range");
      throw error; // the app's error handler logs it and answers 500
    }
  };
}

async function handle(c: Context<AppEnv>, url: URL, match: RouteMatch, options: RouterOptions): Promise<Response> {
  const { db, logger, operations } = options;
  // The route decides the credential: service and user routes never share one.
  const principal = c.get("principal");
  if (match.route.auth === "service") return await handleService(c, url, match, options);
  if (principal?.kind !== "user") throw new DomainError("unauthorized", "Authentication required");

  const operation = operationFor(operations, match.group, match.op);
  if (!operation) throw new DomainError("not_found", "Route not found");

  const required = requiredScope(match.route);
  if (!principal.scopes.includes(required)) throw new DomainError("forbidden", `Missing scope: ${required}`);
  if (match.route.webOnly && principal.channelIdentityId !== undefined) {
    throw new DomainError("forbidden", "Not available to chat tokens");
  }
  // Agent-store routes (an explicit `scope`) act for one linked chat (Convex `requireCaller`).
  if (match.route.scope !== undefined && principal.channelIdentityId === undefined) {
    throw new DomainError("forbidden", "Agent routes need a token for a linked chat");
  }

  let idempotencyKey: string | undefined;
  if (requiresIdempotencyKey(match.route)) {
    const parsed = idempotencyKeySchema.safeParse(c.req.header(IDEMPOTENCY_KEY_HEADER));
    if (!parsed.success) {
      throw new DomainError("validation_failed", `Missing or invalid ${IDEMPOTENCY_KEY_HEADER} header`, {
        issues: [{ path: IDEMPOTENCY_KEY_HEADER, message: parsed.error.issues[0]?.message ?? "Required" }],
      });
    }
    idempotencyKey = parsed.data;
  }

  const write = isWriteRoute(match.route);
  const input = parseInput(match, write ? await readJsonBody(c.req.raw) : url.searchParams);

  if (!write) {
    const data = await readTx(db, async (tx) => {
      await assertChannelIdentity(tx, principal, required);
      return await operation.handler(tx, principal, input);
    });
    if (data instanceof CommittedFailure) throw data.error; // nothing to commit in a read
    return c.json(ok(data));
  }

  const record: IdempotencyRecord | null = idempotencyKey
    ? { userId: principal.userId, key: idempotencyKey, hash: requestHash(match.name, input) }
    : null;
  const result = await withTx(
    db,
    async (tx) => {
      await assertChannelIdentity(tx, principal, required);
      if (record) {
        const claim = await claimKey(tx, record);
        if (!claim.claimed) return { replayed: true, data: claim.data };
      }
      const data = await operation.handler(tx, principal, input);
      if (data instanceof CommittedFailure) {
        // A replay would answer the stored failure as a success: only routes without a key may do this.
        if (record) throw new Error(`${match.name}: commitThenFail on a route with an Idempotency-Key`);
        return { replayed: false, failure: data.error };
      }
      return { replayed: false, data: record ? await storeResponse(tx, record, data) : data };
    },
    { onRetry: ({ attempt, code }) => logger.debug("tx_retry", { operation: match.name, attempt, sqlState: code }) },
  );
  if ("failure" in result) throw result.failure;
  if (result.replayed) c.header(REPLAYED_HEADER, "true");
  return c.json(ok(result.data));
}

/** A service route: the service key, no user, no scope, no `Idempotency-Key`. */
async function handleService(c: Context<AppEnv>, url: URL, match: RouteMatch, options: RouterOptions): Promise<Response> {
  if (c.get("principal")?.kind !== "service") throw new DomainError("unauthorized", "Invalid service credentials");
  const operation = serviceOperationFor(options.serviceOperations, match.group, match.op);
  if (!operation) throw new DomainError("not_found", "Route not found");

  const write = isWriteRoute(match.route);
  const input = parseInput(match, write ? await readJsonBody(c.req.raw) : url.searchParams);
  const ctx = { tokens: options.tokens };
  const data = write
    ? await withTx(options.db, (tx) => operation.handler(tx, ctx, input), {
        onRetry: ({ attempt, code }) => options.logger.debug("tx_retry", { operation: match.name, attempt, sqlState: code }),
      })
    : await readTx(options.db, (tx) => operation.handler(tx, ctx, input));
  return c.json(ok(data));
}

/**
 * Tokens minted for a chat carry its identity: check it in the request's own
 * transaction, so an unlinked or read-only identity stops working at once
 * instead of when the token expires.
 */
async function assertChannelIdentity(tx: Tx, principal: UserPrincipal, required: TokenScope): Promise<void> {
  if (principal.channelIdentityId === undefined) return;
  const problem = await channelTokenProblem(tx, principal.userId, principal.channelIdentityId, required);
  if (problem === "revoked") throw new DomainError("unauthorized", "Channel link revoked");
  if (problem === "scope") throw new DomainError("forbidden", `Channel link lacks the ${required} scope`);
}

function parseInput(match: RouteMatch, source: URLSearchParams | Record<string, unknown> | undefined): never {
  let parsed: ReturnType<typeof match.route.request.safeParse>;
  try {
    parsed = match.route.request.safeParse(mergeRequestInput(match, source));
  } catch {
    // A validator can still throw on pathological input (e.g. nesting deep enough to overflow the stack).
    throw new DomainError("validation_failed", "Request validation failed");
  }
  if (!parsed.success) {
    throw new DomainError("validation_failed", "Request validation failed", validationIssues(parsed.error));
  }
  // Typed by each operation from its own route.
  return parsed.data as never;
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
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new DomainError("validation_failed", "Request body too large");
  let text: string;
  try {
    text = await readBodyText(request.body, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new DomainError("validation_failed", "Request body too large");
    throw error;
  }
  if (text.trim() === "") return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new DomainError("validation_failed", "Request body is not valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new DomainError("validation_failed", "Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}
