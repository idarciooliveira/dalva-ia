import type { RouteDef, RouteParsedInput } from "@mpf/finance-contract";
import { v } from "convex/values";
import type { z } from "zod";

import type { Doc } from "../../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../../_generated/server";
import { channelTokenProblem } from "../../domain/channelLinks";
import { apiError, mapDomainErrors, type HandlerFailure } from "./errors";
import { IDEMPOTENCY_TTL_MS } from "./idempotency";

/** What a handler returns: the response schema's input side (plain-string ids). */
export type RouteResponse<R extends RouteDef> = z.input<R["response"]>;

export type ReadHandler<R extends RouteDef> = (
  ctx: QueryCtx,
  userId: string,
  input: RouteParsedInput<R>,
) => Promise<RouteResponse<R>>;

export type WriteHandler<R extends RouteDef> = (
  ctx: MutationCtx,
  userId: string,
  input: RouteParsedInput<R>,
) => Promise<RouteResponse<R>>;

export interface WriteResult<T> {
  replayed: boolean;
  data: T;
}

/**
 * Tokens minted for a chat channel carry its identity id. Check it inside the
 * same transaction as the read or write, so an unlinked or read-only identity
 * stops working immediately instead of when the token expires.
 */
async function assertChannelIdentity(
  ctx: QueryCtx,
  userId: string,
  channelIdentityId: string | undefined,
  required: "finance:read" | "finance:write",
) {
  if (channelIdentityId === undefined) return;
  const problem = await channelTokenProblem(ctx, userId, channelIdentityId, required);
  if (problem === "revoked") throw apiError("unauthorized", "Channel link revoked");
  if (problem === "scope") throw apiError("forbidden", `Channel link lacks the ${required} scope`);
}

/**
 * Internal query for a GET route. `userId` comes from the verified token
 * (the httpAction is the only caller); `input` is already contract-validated.
 */
export function apiQuery<R extends RouteDef>(_route: R, handler: ReadHandler<R>) {
  return internalQuery({
    args: { userId: v.string(), input: v.any(), channelIdentityId: v.optional(v.string()) },
    handler: async (ctx, args): Promise<RouteResponse<R>> => {
      await assertChannelIdentity(ctx, args.userId, args.channelIdentityId, "finance:read");
      return await mapDomainErrors(() => handler(ctx, args.userId, args.input as RouteParsedInput<R>));
    },
  });
}

/**
 * Internal mutation for a write route, with idempotency in the same
 * transaction as the write:
 * - unknown key: run the handler, store `(userId, key) -> hash + data`
 * - same key, same hash: return the stored data, nothing is re-executed
 * - same key, different hash: `conflict`
 * - keys older than the TTL count as unused, whether or not the cron ran
 * Handler errors throw, so the write and the key record roll back together
 * and a failed request can be retried with the same key.
 */
export function apiMutation<R extends RouteDef>(_route: R, handler: WriteHandler<R>) {
  return internalMutation({
    args: {
      userId: v.string(),
      input: v.any(),
      idempotencyKey: v.string(),
      requestHash: v.string(),
      channelIdentityId: v.optional(v.string()),
    },
    handler: async (ctx, args): Promise<WriteResult<RouteResponse<R>>> => {
      await assertChannelIdentity(ctx, args.userId, args.channelIdentityId, "finance:write");
      const existing = await ctx.db
        .query("apiIdempotencyKeys")
        .withIndex("by_userId_and_key", (q) => q.eq("userId", args.userId).eq("key", args.idempotencyKey))
        .unique();
      if (existing && existing.createdAt < Date.now() - IDEMPOTENCY_TTL_MS) {
        // Expired but not purged yet: behave exactly as after the purge.
        await ctx.db.delete(existing._id);
      } else if (existing) {
        if (existing.requestHash !== args.requestHash) {
          throw apiError("conflict", "Idempotency-Key was already used with a different request");
        }
        return { replayed: true, data: existing.response as RouteResponse<R> };
      }

      const data = await mapDomainErrors(() => handler(ctx, args.userId, args.input as RouteParsedInput<R>));
      await ctx.db.insert("apiIdempotencyKeys", {
        userId: args.userId,
        key: args.idempotencyKey,
        requestHash: args.requestHash,
        response: data,
        createdAt: Date.now(),
      });
      return { replayed: false, data };
    },
  });
}


/* -------------------------------------------------------------------------- */
/*  Agent store routes (`agent:state`)                                        */
/* -------------------------------------------------------------------------- */

/** Who an agent-store call acts for: the token's user and the chat identity it was resolved for. */
export interface AgentCaller {
  userId: string;
  identity: Doc<"channelIdentities">;
}

export type AgentReadHandler<R extends RouteDef> = (
  ctx: QueryCtx,
  caller: AgentCaller,
  input: RouteParsedInput<R>,
) => Promise<RouteResponse<R>>;

export type AgentWriteHandler<R extends RouteDef> = (
  ctx: MutationCtx,
  caller: AgentCaller,
  input: RouteParsedInput<R>,
) => Promise<RouteResponse<R> | HandlerFailure>;

/**
 * Agent-store calls need a token minted for a channel identity (`cid`), and
 * that identity must still be active. Unlike finance routes there is no
 * read/write scope check beyond `agent:state` (the router did that), so a
 * read-only identity keeps its conversation state.
 */
async function requireCaller(ctx: QueryCtx, userId: string, channelIdentityId: string | undefined): Promise<AgentCaller> {
  if (channelIdentityId === undefined) throw apiError("forbidden", "Agent routes need a token for a linked chat");
  const id = ctx.db.normalizeId("channelIdentities", channelIdentityId);
  const identity = id ? await ctx.db.get(id) : null;
  if (!identity || identity.userId !== userId || identity.unlinkedAt !== undefined) {
    throw apiError("unauthorized", "Channel link revoked");
  }
  return { userId, identity };
}

/** Internal query for a GET agent-store route. */
export function agentQuery<R extends RouteDef>(_route: R, handler: AgentReadHandler<R>) {
  return internalQuery({
    args: { userId: v.string(), input: v.any(), channelIdentityId: v.optional(v.string()) },
    handler: async (ctx, args): Promise<RouteResponse<R>> => {
      const caller = await requireCaller(ctx, args.userId, args.channelIdentityId);
      return await mapDomainErrors(() => handler(ctx, caller, args.input as RouteParsedInput<R>));
    },
  });
}

/**
 * Internal mutation for a write agent-store route. No idempotency record:
 * these writes either are naturally safe to repeat (a second `confirm` is a
 * `conflict`) or belong to a single-threaded chat. A handler may return a
 * `handlerFailure` to commit its writes and still answer with an error.
 */
export function agentMutation<R extends RouteDef>(_route: R, handler: AgentWriteHandler<R>) {
  return internalMutation({
    args: { userId: v.string(), input: v.any(), channelIdentityId: v.optional(v.string()) },
    handler: async (ctx, args): Promise<RouteResponse<R> | HandlerFailure> => {
      const caller = await requireCaller(ctx, args.userId, args.channelIdentityId);
      return await mapDomainErrors(() => handler(ctx, caller, args.input as RouteParsedInput<R>));
    },
  });
}
