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
const UNSTORABLE_TEXT = new Set(["22021", "22P05"]);
const DATE_OUT_OF_RANGE = "22008";

export interface RouterOptions {
  db: Database;
  logger: Logger;
  operations: Operations;
  serviceOperations: ServiceOperations;
  tokens: UserTokens;
}

export function contractRouter(options: RouterOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const match = matchRoute(c.req.method, url.pathname);
    if (!match) return await next();
    try {
      return await handle(c, url, match, options);
    } catch (error) {
      if (error instanceof DomainError) return errorResponse(c, error.code, error.message, error.details);
      if (UNSTORABLE_TEXT.has(sqlState(error) ?? "")) {
        return errorResponse(c, "validation_failed", "Text contains characters that can't be stored");
      }
      if (sqlState(error) === DATE_OUT_OF_RANGE) return errorResponse(c, "validation_failed", "Date out of range");
      if (error instanceof MoneyRangeError) return errorResponse(c, "conflict", "Amount out of range");
      throw error;
    }
  };
}

async function handle(c: Context<AppEnv>, url: URL, match: RouteMatch, options: RouterOptions): Promise<Response> {
  const { db, logger, operations } = options;
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
    if (data instanceof CommittedFailure) throw data.error;
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
    throw new DomainError("validation_failed", "Request validation failed");
  }
  if (!parsed.success) {
    throw new DomainError("validation_failed", "Request validation failed", validationIssues(parsed.error));
  }
  return parsed.data as never;
}

export class BodyTooLargeError extends Error {
  override name = "BodyTooLargeError";
}

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
