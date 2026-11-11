import { v } from "convex/values";

import { internal } from "./_generated/api";
import { action, internalMutation, mutation, query } from "./_generated/server";
import * as channelLinks from "./domain/channelLinks";
import { requireUserId } from "./lib/auth";
import { generateLinkCode, hashLinkCode } from "./lib/linkCodes";
import { channelValidator } from "./schema";

/* -------------------------------------------------------------------------- */
/*  Web-facing channel linking (Settings → Telegram). Convex Auth only.       */
/* -------------------------------------------------------------------------- */

export const CONSENT_REQUIRED = "Consent is required to link a chat channel";

/**
 * Create a single-use link code. An action so the code comes from a
 * non-deterministic CSPRNG; only its hash reaches the database. The raw code
 * is returned once and never stored.
 */
export const createLinkCode = action({
  args: { channel: channelValidator, consent: v.boolean() },
  handler: async (ctx, args): Promise<{ code: string; expiresAt: number }> => {
    const userId = await requireUserId(ctx);
    if (args.consent !== true) throw new Error(CONSENT_REQUIRED);
    const code = generateLinkCode();
    const { expiresAt }: { expiresAt: number } = await ctx.runMutation(internal.channelLinks.storeLinkCode, {
      userId,
      channel: args.channel,
      codeHash: await hashLinkCode(code),
    });
    return { code, expiresAt };
  },
});

/** Called only by `createLinkCode`, with the userId it derived from the session. */
export const storeLinkCode = internalMutation({
  args: { userId: v.string(), channel: channelValidator, codeHash: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await channelLinks.storeLinkCode(ctx, args.userId, {
      channel: args.channel,
      codeHash: args.codeHash,
      consentAt: now,
      now,
    });
  },
});

/** Active links of the current user, for the settings page (live). */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const identities = await channelLinks.listActiveForUser(ctx, userId);
    return identities.map((identity) => ({
      _id: identity._id,
      channel: identity.channel,
      username: identity.username,
      linkedAt: identity.linkedAt,
      readOnly: !identity.scopes.includes("finance:write"),
    }));
  },
});

export const unlink = mutation({
  args: { identityId: v.id("channelIdentities") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await channelLinks.unlinkForUser(ctx, userId, args.identityId, Date.now());
    return null;
  },
});

/** Read-only: the bot gets `finance:read` only. Otherwise `finance:read` + `finance:write`. */
export const setReadOnly = mutation({
  args: { identityId: v.id("channelIdentities"), readOnly: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await channelLinks.setReadOnly(ctx, userId, args.identityId, args.readOnly);
    return null;
  },
});

const PURGE_BATCH = 500;

/** Cron: delete expired codes (used or not), rescheduling while a batch is full. */
export const purgeExpiredCodes = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const deleted = await channelLinks.purgeExpiredCodes(ctx, now, PURGE_BATCH);
    if (deleted === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.channelLinks.purgeExpiredCodes, { now });
    }
    return deleted;
  },
});
