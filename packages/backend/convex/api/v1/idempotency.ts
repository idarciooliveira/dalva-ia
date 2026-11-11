import { v } from "convex/values";

import { internal } from "../../_generated/api";
import { internalMutation } from "../../_generated/server";

/** Idempotency keys are replayable for this long, then purged. */
export const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PURGE_BATCH = 500;

/** Daily cron: delete keys older than the TTL, in batches that reschedule themselves. */
export const purgeExpired = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const expired = await ctx.db
      .query("apiIdempotencyKeys")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", now - IDEMPOTENCY_TTL_MS))
      .take(PURGE_BATCH);
    for (const row of expired) await ctx.db.delete(row._id);
    if (expired.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.api.v1.idempotency.purgeExpired, { now });
    }
    return expired.length;
  },
});
