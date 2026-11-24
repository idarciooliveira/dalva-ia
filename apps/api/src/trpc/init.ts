/**
 * The API: tRPC at `/api/trpc`. Context and procedure builders; every
 * procedure picks one, and the builder does the rest in this order:
 *
 *   credential (401) → web-only / scope (403) → Idempotency-Key (400)
 *   → transaction [channel identity re-check → idempotency claim → input (400) → procedure]
 *
 * - `financeRead` / `financeWrite`: finance data, web app and chat agent.
 * - `webRead` / `webWrite`: web app only (chat tokens get `forbidden`).
 * - `webWriteNoKey`: web-only writes without `Idempotency-Key` (chat links).
 * - `agentRead` / `agentWrite`: the agent store, `agent:state` scope, a token for a linked chat.
 * - `serviceRead` / `serviceWrite`: the agent's service key, acting for no user.
 *
 * Procedures get `ctx.tx` (a read-only snapshot for queries, the SERIALIZABLE
 * write transaction for mutations, rerun on serialization failure) and
 * `ctx.user`; filter every query by `ctx.user.userId`, never take a user id
 * from the input. Throw `DomainError` (`src/domain/errors.ts`).
 */
import { initTRPC } from "@trpc/server";
import type { MiddlewareResult } from "@trpc/server/unstable-core-do-not-import";

import type { Database } from "../db/client";
import { readTx, type Tx, withTx } from "../db/tx";
import { channelTokenProblem } from "../domain/channelLinks";
import { DomainError } from "../domain/errors";
import { claimKey, requestHash, storeResponse } from "../http/idempotency";
import type { Principal, Scope, UserPrincipal } from "../http/principal";
import type { UserTokens } from "../auth/tokens";
import type { Logger } from "../log";
import { domainErrorOf, fail, formatError, trpcError } from "./errors";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const REPLAYED_HEADER = "Idempotent-Replayed";
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export type TrpcContext = {
  db: Database;
  logger: Logger;
  /** Null when anonymous. */
  principal: Principal | null;
  /** Set when a credential was sent but is invalid: every procedure answers `unauthorized` with it. */
  credentialError: string | null;
  /** The raw `Idempotency-Key` header. */
  idempotencyKey: string | undefined;
  /** Procedure calls in this HTTP request (>1 for a batch). */
  batchSize: number;
  /** Headers of the HTTP response. */
  resHeaders: Headers;
  /** Mints the user tokens `channelIdentities.resolve` hands out. */
  tokens: UserTokens;
  /** Server settings procedures read. */
  settings: TrpcSettings;
};

export interface TrpcSettings {
  /** `TELEGRAM_BOT_USERNAME`, for the web's `t.me` deep link. */
  telegramBotUsername?: string;
}

/**
 * Agent-store writes that must keep what they wrote and still fail (a pending
 * action found expired on confirm is marked `expired`): `throw commitThenFail(error)`.
 */
export class CommittedFailure extends Error {
  override name = "CommittedFailure";
  constructor(readonly error: DomainError) {
    super(error.message);
  }
}

export const commitThenFail = (error: DomainError) => new CommittedFailure(error);

const t = initTRPC.context<TrpcContext>().create({
  errorFormatter: ({ shape, error }) => ({ ...shape, ...formatError(error, shape.data) }),
});

export const router = t.router;

/** Outermost: `DomainError`, input and known database errors → a `TRPCError` with the v1 code (see errors.ts). */
const mapErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (result.ok) return result;
  const domain = domainErrorOf(result.error);
  if (domain) throw trpcError(domain);
  return result;
});

const authed = t.procedure.use(mapErrors).use(({ ctx, next }) => {
  if (ctx.credentialError !== null) throw fail("unauthorized", ctx.credentialError);
  if (ctx.principal?.kind !== "user") throw fail("unauthorized", "Authentication required");
  return next({ ctx: { user: ctx.principal } });
});

const webOnly = authed.use(({ ctx, next }) => {
  if (ctx.user.channelIdentityId !== undefined) throw fail("forbidden", "Not available to chat tokens");
  return next();
});

function requireScope(user: UserPrincipal, scope: Scope): void {
  if (!user.scopes.includes(scope)) throw fail("forbidden", `Missing scope: ${scope}`);
}

/** Unlinking a chat or making it read-only applies at once: checked inside each request's transaction. */
async function assertChannelIdentity(tx: Tx, user: UserPrincipal, scope: Scope): Promise<void> {
  if (user.channelIdentityId === undefined) return;
  const problem = await channelTokenProblem(tx, user.userId, user.channelIdentityId, scope);
  if (problem === "revoked") throw new DomainError("unauthorized", "Channel link revoked");
  if (problem === "scope") throw new DomainError("forbidden", `Channel link lacks the ${scope} scope`);
}

function read(base: typeof authed) {
  return base.use(async ({ ctx, next }) => {
    requireScope(ctx.user, "finance:read");
    return await readTx(ctx.db, async (tx) => {
      await assertChannelIdentity(tx, ctx.user, "finance:read");
      const result = await next({ ctx: { tx } });
      // Thrown, so the transaction ends with the error.
      if (!result.ok) throw result.error;
      return result;
    });
  });
}

/**
 * Finance write: one `Idempotency-Key` per call, stored with the response in
 * the write's own transaction (`src/http/idempotency.ts`). The hash covers the
 * procedure path and the raw input (the body as sent), so a replay needs the
 * same call byte for byte, modulo key order.
 */
function write(base: typeof authed) {
  return base.use(async ({ ctx, path, getRawInput, next }) => {
    requireScope(ctx.user, "finance:write");
    const key = ctx.idempotencyKey;
    if (key === undefined || !IDEMPOTENCY_KEY_RE.test(key)) {
      throw fail("validation_failed", `Missing or invalid ${IDEMPOTENCY_KEY_HEADER} header`, {
        issues: [{ path: IDEMPOTENCY_KEY_HEADER, message: key === undefined ? "Required" : "Idempotency key must be 8-128 chars of [A-Za-z0-9._:-]" }],
      });
    }
    // One header can't key several writes.
    if (ctx.batchSize > 1) throw fail("validation_failed", "Writes with an Idempotency-Key can't be batched");

    const record = { userId: ctx.user.userId, key, hash: requestHash(path, await getRawInput()) };
    const outcome = await withTx(
      ctx.db,
      async (tx) => {
        await assertChannelIdentity(tx, ctx.user, "finance:write");
        const claim = await claimKey(tx, record);
        if (!claim.claimed) return { replayed: true as const, data: claim.data };
        const result = await next({ ctx: { tx } });
        // Thrown, so the write rolls back with its claim (and `withTx` reruns serialization failures).
        if (!result.ok) throw result.error;
        return { replayed: false as const, result: { ...result, data: await storeResponse(tx, record, result.data) } };
      },
      { onRetry: ({ attempt, code }) => ctx.logger.debug("tx_retry", { operation: path, attempt, sqlState: code }) },
    );
    if (!outcome.replayed) return outcome.result;
    ctx.resHeaders.set(REPLAYED_HEADER, "true");
    // The stored response of the first call. Its procedure doesn't run, so this result is built here.
    const replay: MiddlewareResult<{ tx: Tx }> = { ok: true, data: outcome.data, marker: undefined as never };
    return replay;
  });
}

/** Web-only writes that take no `Idempotency-Key`: a stored replay of a link code would keep the raw code. */
export const webWriteNoKey = webOnly.use(async ({ ctx, path, next }) => {
  requireScope(ctx.user, "finance:write");
  return await withTx(
    ctx.db,
    async (tx) => {
      const result = await next({ ctx: { tx } });
      if (!result.ok) throw result.error;
      return result;
    },
    { onRetry: ({ attempt, code }) => ctx.logger.debug("tx_retry", { operation: path, attempt, sqlState: code }) },
  );
});

/** The agent store: `agent:state`, and only with a token minted for a linked chat. */
const agentStore = authed.use(({ ctx, next }) => {
  requireScope(ctx.user, "agent:state");
  if (ctx.user.channelIdentityId === undefined) throw fail("forbidden", "Agent routes need a token for a linked chat");
  return next();
});

export const agentRead = agentStore.use(async ({ ctx, next }) => {
  return await readTx(ctx.db, async (tx) => {
    await assertChannelIdentity(tx, ctx.user, "agent:state");
    const result = await next({ ctx: { tx } });
    if (!result.ok) throw result.error;
    return result;
  });
});

/** No `Idempotency-Key`. A `CommittedFailure` commits the transaction, then answers its error. */
export const agentWrite = agentStore.use(async ({ ctx, path, next }) => {
  const outcome = await withTx(
    ctx.db,
    async (tx) => {
      await assertChannelIdentity(tx, ctx.user, "agent:state");
      const result = await next({ ctx: { tx } });
      if (!result.ok) {
        if (result.error.cause instanceof CommittedFailure) return { committed: false as const, failure: result.error.cause.error };
        throw result.error;
      }
      return { committed: true as const, result };
    },
    { onRetry: ({ attempt, code }) => ctx.logger.debug("tx_retry", { operation: path, attempt, sqlState: code }) },
  );
  if (!outcome.committed) throw trpcError(outcome.failure);
  return outcome.result;
});

/** The agent's service key. Service procedures act for no user: each finds the user from server state. */
const service = t.procedure.use(mapErrors).use(({ ctx, next }) => {
  if (ctx.credentialError !== null) throw fail("unauthorized", ctx.credentialError);
  if (ctx.principal?.kind !== "service") throw fail("unauthorized", "Invalid service credentials");
  return next();
});

export const serviceRead = service.use(async ({ ctx, next }) => {
  return await readTx(ctx.db, async (tx) => {
    const result = await next({ ctx: { tx } });
    if (!result.ok) throw result.error;
    return result;
  });
});

export const serviceWrite = service.use(async ({ ctx, path, next }) => {
  return await withTx(
    ctx.db,
    async (tx) => {
      const result = await next({ ctx: { tx } });
      if (!result.ok) throw result.error;
      return result;
    },
    { onRetry: ({ attempt, code }) => ctx.logger.debug("tx_retry", { operation: path, attempt, sqlState: code }) },
  );
});

/** Web app and chat agent. */
export const financeRead = read(authed);
export const financeWrite = write(authed);
/** Web app only: chat tokens get `forbidden`, so the agent can neither call nor propose these. */
export const webRead = read(webOnly);
export const webWrite = write(webOnly);
