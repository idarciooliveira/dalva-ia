/**
 * tRPC on `/api/trpc`: context and procedure builders. They do what
 * `src/http/router.ts` does for `/api/v1`, in the same order:
 *
 *   credential (401) → web-only (403) → scope (403) → Idempotency-Key (400)
 *   → transaction [channel identity re-check → idempotency claim → input (400) → procedure]
 *
 * Pick a builder per procedure: `financeRead` / `financeWrite` (web app and
 * chat agent), `webRead` / `webWrite` (web app only). Procedures get `ctx.tx`
 * (a read-only snapshot for queries, the SERIALIZABLE write transaction for
 * mutations, rerun on serialization failure) and `ctx.user`; filter every
 * query by `ctx.user.userId`. Throw `DomainError` as in `/api/v1`.
 */
import { initTRPC } from "@trpc/server";
import type { MiddlewareResult } from "@trpc/server/unstable-core-do-not-import";

import type { Database } from "../db/client";
import { readTx, type Tx, withTx } from "../db/tx";
import { channelTokenProblem } from "../domain/channelLinks";
import { DomainError } from "../domain/errors";
import { claimKey, requestHash, storeResponse } from "../http/idempotency";
import type { Principal, Scope, UserPrincipal } from "../http/principal";
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
};

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

/** Web app and chat agent. */
export const financeRead = read(authed);
export const financeWrite = write(authed);
/** Web app only: chat tokens get `forbidden`, so the agent can neither call nor propose these. */
export const webRead = read(webOnly);
export const webWrite = write(webOnly);
