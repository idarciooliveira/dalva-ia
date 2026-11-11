import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation, mutation } from "./_generated/server";
import * as agentStore from "./domain/agentStore";
import { requireUserId } from "./lib/auth";

/* -------------------------------------------------------------------------- */
/*  Web: "Delete chat history" (Settings → Telegram). Convex Auth only.       */
/* -------------------------------------------------------------------------- */

/** Delete the signed-in user's chat history: sessions, messages and pending actions, for every channel. */
export const deleteMyHistory = mutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    await agentStore.deleteUserHistory(ctx, await requireUserId(ctx));
    return null;
  },
});

/* -------------------------------------------------------------------------- */
/*  Batched continuations (scheduled by history deletion)                     */
/* -------------------------------------------------------------------------- */

const budgetArg = v.optional(v.number());
const clampBudget = (budget: number | undefined) =>
  Math.max(1, Math.min(budget ?? agentStore.HISTORY_DELETE_BUDGET, agentStore.HISTORY_DELETE_BUDGET));

export const purgeUserHistory = internalMutation({
  args: { userId: v.string(), before: v.number(), budget: budgetArg },
  handler: async (ctx, args): Promise<number> => {
    const { used, more } = await agentStore.deleteHistoryBatch(ctx, { userId: args.userId }, args.before, clampBudget(args.budget));
    if (more) await ctx.scheduler.runAfter(0, internal.agentStore.purgeUserHistory, args);
    return used;
  },
});

export const purgeIdentityHistory = internalMutation({
  args: { identityId: v.id("channelIdentities"), before: v.number(), budget: budgetArg },
  handler: async (ctx, args): Promise<number> => {
    const { used, more } = await agentStore.deleteHistoryBatch(ctx, { identityId: args.identityId }, args.before, clampBudget(args.budget));
    if (more) await ctx.scheduler.runAfter(0, internal.agentStore.purgeIdentityHistory, args);
    return used;
  },
});

/* -------------------------------------------------------------------------- */
/*  Retention crons. Each run is bounded and reschedules itself while full.   */
/* -------------------------------------------------------------------------- */

const batchArgs = { now: v.optional(v.number()), batch: v.optional(v.number()) };
const clampBatch = (batch: number | undefined) => Math.max(1, Math.min(batch ?? agentStore.PURGE_BATCH, agentStore.PURGE_BATCH));

/** Inbound events hold message text: delete them 24h after their last update (done, failed or abandoned). */
export const purgeInboundEvents = internalMutation({
  args: batchArgs,
  handler: async (ctx, args): Promise<number> => {
    const now = args.now ?? Date.now();
    const batch = clampBatch(args.batch);
    const deleted = await agentStore.purgeStaleEvents(ctx, now - agentStore.EVENT_RETENTION_MS, batch);
    if (deleted >= batch) await ctx.scheduler.runAfter(0, internal.agentStore.purgeInboundEvents, args);
    return deleted;
  },
});

/** Pending actions past `expiresAt` become `expired`. */
export const expirePendingActions = internalMutation({
  args: batchArgs,
  handler: async (ctx, args): Promise<number> => {
    const now = args.now ?? Date.now();
    const batch = clampBatch(args.batch);
    const expired = await agentStore.expirePendingActions(ctx, now, batch);
    if (expired >= batch) await ctx.scheduler.runAfter(0, internal.agentStore.expirePendingActions, args);
    return expired;
  },
});

/** Sessions (with messages and actions) inactive for 30 days, and finished actions of that age. */
export const purgeInactiveHistory = internalMutation({
  args: batchArgs,
  handler: async (ctx, args): Promise<number> => {
    const now = args.now ?? Date.now();
    const { used, more } = await agentStore.purgeInactiveHistory(ctx, now, clampBatch(args.batch));
    if (more) await ctx.scheduler.runAfter(0, internal.agentStore.purgeInactiveHistory, args);
    return used;
  },
});
