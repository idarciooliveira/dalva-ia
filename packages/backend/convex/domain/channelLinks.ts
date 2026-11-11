import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type Channel = Doc<"channelIdentities">["channel"];
export type ChannelScope = Doc<"channelIdentities">["scopes"][number];

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
export const READ_WRITE_SCOPES: ChannelScope[] = ["finance:read", "finance:write"];
export const READ_ONLY_SCOPES: ChannelScope[] = ["finance:read"];

/*
 * Error messages are mapped to API codes in api/v1/errors.ts. The invalid-code
 * message is the same for unknown, used, expired and wrong-channel codes, so a
 * caller can't tell which case it hit.
 */
export const INVALID_LINK_CODE = "Link code is invalid or expired";
export const EXTERNAL_ALREADY_LINKED = "This chat account is already linked to a DALVA account";
export const USER_ALREADY_LINKED = "This DALVA account is already linked to another chat account";
export const CHANNEL_ALREADY_LINKED = "Channel is already linked. Unlink it first";
export const IDENTITY_NOT_FOUND = "Channel identity not found";
export const PRIVATE_CHAT_REQUIRED = "Link codes must be sent in a private chat with the bot";

const MAX_PENDING_CODES = 50;

export async function findActiveByExternal(ctx: QueryCtx, channel: Channel, externalUserId: string) {
  return await ctx.db
    .query("channelIdentities")
    .withIndex("by_channel_and_externalUserId_and_unlinkedAt", (q) =>
      q.eq("channel", channel).eq("externalUserId", externalUserId).eq("unlinkedAt", undefined),
    )
    .first();
}

export async function findActiveByUser(ctx: QueryCtx, userId: string, channel: Channel) {
  return await ctx.db
    .query("channelIdentities")
    .withIndex("by_userId_and_channel_and_unlinkedAt", (q) =>
      q.eq("userId", userId).eq("channel", channel).eq("unlinkedAt", undefined),
    )
    .first();
}

/** Active links of a user (at most one per channel). */
export async function listActiveForUser(ctx: QueryCtx, userId: string) {
  return await ctx.db
    .query("channelIdentities")
    .withIndex("by_userId_and_unlinkedAt", (q) => q.eq("userId", userId).eq("unlinkedAt", undefined))
    .take(20);
}

/**
 * Store a new code for the user. Previous unused codes for the channel are
 * deleted, so only the latest one shown in the UI works.
 */
export async function storeLinkCode(
  ctx: MutationCtx,
  userId: string,
  args: { channel: Channel; codeHash: string; consentAt: number; now: number },
) {
  if (await findActiveByUser(ctx, userId, args.channel)) throw new Error(CHANNEL_ALREADY_LINKED);
  const previous = await ctx.db
    .query("channelLinkCodes")
    .withIndex("by_userId_and_channel", (q) => q.eq("userId", userId).eq("channel", args.channel))
    .take(MAX_PENDING_CODES);
  for (const code of previous) {
    if (code.usedAt === undefined) await ctx.db.delete(code._id);
  }
  const expiresAt = args.now + LINK_CODE_TTL_MS;
  await ctx.db.insert("channelLinkCodes", {
    userId,
    channel: args.channel,
    codeHash: args.codeHash,
    expiresAt,
    consentAt: args.consentAt,
  });
  return { expiresAt };
}

/**
 * Consume a code and link the chat account to the code's owner. Runs in one
 * serializable mutation: two concurrent redeems for the same code or the same
 * chat account conflict and retry, and the loser sees the winner's write.
 */
export async function redeemLinkCode(
  ctx: MutationCtx,
  args: {
    codeHash: string;
    channel: Channel;
    externalUserId: string;
    chatId: string;
    username?: string;
    now: number;
  },
): Promise<Doc<"channelIdentities">> {
  const code = await ctx.db
    .query("channelLinkCodes")
    .withIndex("by_codeHash", (q) => q.eq("codeHash", args.codeHash))
    .first();
  if (!code || code.usedAt !== undefined || code.expiresAt <= args.now || code.channel !== args.channel) {
    throw new Error(INVALID_LINK_CODE);
  }
  // Telegram private chats share the user's id; anything else is a group or channel,
  // where the bot would later answer finance questions in front of other members.
  if (args.channel === "telegram" && args.chatId !== args.externalUserId) throw new Error(PRIVATE_CHAT_REQUIRED);
  const userId = code.userId; // the only source of userId: the server-side code row

  const byExternal = await findActiveByExternal(ctx, args.channel, args.externalUserId);
  if (byExternal) throw new Error(EXTERNAL_ALREADY_LINKED);
  if (await findActiveByUser(ctx, userId, args.channel)) throw new Error(USER_ALREADY_LINKED);

  await ctx.db.patch(code._id, { usedAt: args.now });

  const id = await ctx.db.insert("channelIdentities", {
    userId,
    channel: args.channel,
    externalUserId: args.externalUserId,
    chatId: args.chatId,
    ...(args.username ? { username: args.username } : {}),
    scopes: READ_WRITE_SCOPES,
    linkedAt: args.now,
    consentAt: code.consentAt,
  });
  return (await ctx.db.get(id))!;
}

/** Active identity for a chat sender, only when the message comes from the linked chat. */
export async function resolveIdentity(
  ctx: QueryCtx,
  args: { channel: Channel; externalUserId: string; chatId: string },
) {
  const identity = await findActiveByExternal(ctx, args.channel, args.externalUserId);
  if (!identity || identity.chatId !== args.chatId) return null;
  const user = await ctx.db.get(identity.userId as Id<"users">);
  if (!user) return null;
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_userId", (q) => q.eq("userId", identity.userId))
    .unique();
  return { identity, displayName: user.name, baseCurrency: profile?.baseCurrency };
}

export async function unlinkByExternal(ctx: MutationCtx, channel: Channel, externalUserId: string, now: number) {
  const identity = await findActiveByExternal(ctx, channel, externalUserId);
  if (!identity) throw new Error(IDENTITY_NOT_FOUND);
  await ctx.db.patch(identity._id, { unlinkedAt: now });
  return identity._id;
}

async function requireOwnedActive(ctx: QueryCtx, userId: string, identityId: Id<"channelIdentities">) {
  const identity = await ctx.db.get(identityId);
  if (!identity || identity.userId !== userId || identity.unlinkedAt !== undefined) {
    throw new Error(IDENTITY_NOT_FOUND);
  }
  return identity;
}

export async function unlinkForUser(ctx: MutationCtx, userId: string, identityId: Id<"channelIdentities">, now: number) {
  const identity = await requireOwnedActive(ctx, userId, identityId);
  await ctx.db.patch(identity._id, { unlinkedAt: now });
}

export async function setReadOnly(
  ctx: MutationCtx,
  userId: string,
  identityId: Id<"channelIdentities">,
  readOnly: boolean,
) {
  const identity = await requireOwnedActive(ctx, userId, identityId);
  await ctx.db.patch(identity._id, { scopes: readOnly ? READ_ONLY_SCOPES : READ_WRITE_SCOPES });
}

/**
 * A token minted for a channel identity stays valid only while that identity
 * is active and still grants `required`. Returns the failure reason, or null.
 */
export async function channelTokenProblem(
  ctx: QueryCtx,
  userId: string,
  channelIdentityId: string,
  required: ChannelScope,
): Promise<"revoked" | "scope" | null> {
  const id = ctx.db.normalizeId("channelIdentities", channelIdentityId);
  const identity = id ? await ctx.db.get(id) : null;
  if (!identity || identity.userId !== userId || identity.unlinkedAt !== undefined) return "revoked";
  if (!identity.scopes.includes(required)) return "scope";
  return null;
}

/** Delete codes (used or not) whose TTL has passed. Returns how many were deleted. */
export async function purgeExpiredCodes(ctx: MutationCtx, now: number, batch: number) {
  const expired = await ctx.db
    .query("channelLinkCodes")
    .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
    .take(batch);
  for (const code of expired) await ctx.db.delete(code._id);
  return expired.length;
}
