import type { RouteDef, RouteParsedInput } from "@mpf/finance-contract";
import { v } from "convex/values";
import type { z } from "zod";

import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../../_generated/server";
import { apiError, mapDomainErrors } from "./errors";

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
 * Internal query for a GET route. `userId` comes from the verified token
 * (the httpAction is the only caller); `input` is already contract-validated.
 */
export function apiQuery<R extends RouteDef>(_route: R, handler: ReadHandler<R>) {
  return internalQuery({
    args: { userId: v.string(), input: v.any() },
    handler: (ctx, args): Promise<RouteResponse<R>> =>
      mapDomainErrors(() => handler(ctx, args.userId, args.input as RouteParsedInput<R>)),
  });
}

/**
 * Internal mutation for a write route, with idempotency in the same
 * transaction as the write:
 * - unknown key: run the handler, store `(userId, key) -> hash + data`
 * - same key, same hash: return the stored data, nothing is re-executed
 * - same key, different hash: `conflict`
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
    },
    handler: async (ctx, args): Promise<WriteResult<RouteResponse<R>>> => {
      const existing = await ctx.db
        .query("apiIdempotencyKeys")
        .withIndex("by_userId_and_key", (q) => q.eq("userId", args.userId).eq("key", args.idempotencyKey))
        .unique();
      if (existing) {
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
