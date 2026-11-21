/**
 * Chat channel linking, ported from `packages/backend/convex/domain/channelLinks.ts`
 * and `lib/linkCodes.ts`. The web app creates a single-use code (only its hash
 * is stored); the agent redeems it from the chat, which links that chat
 * account to the code's owner. The user id always comes from server state: the
 * session that created the code, or the code row on redeem.
 */
import { createHash, randomBytes } from "node:crypto";

import type { TokenScope } from "@mpf/finance-contract";
import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";

import type { Database } from "../db/client";
import { channelIdentities, channelLinkCodes, userProfiles, users } from "../db/schema";
import type { Tx } from "../db/tx";
import { deleteIdentityHistory } from "./agentStore";
import { conflict, DomainError } from "./errors";

export type ChannelIdentity = typeof channelIdentities.$inferSelect;
export type Channel = ChannelIdentity["channel"];
export type ChannelScope = ChannelIdentity["scopes"][number];

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
export const READ_WRITE_SCOPES: ChannelScope[] = ["finance:read", "finance:write"];
export const READ_ONLY_SCOPES: ChannelScope[] = ["finance:read"];
/** 32 random bytes → 43 chars of base64url: Telegram `start`-param safe (`[A-Za-z0-9_-]`, at most 64). */
const LINK_CODE_BYTES = 32;
/** Convex read at most this many links per user (one per channel in practice). */
const LIST_LIMIT = 20;

/*
 * Same messages as Convex. The invalid-code message is the same for unknown,
 * used, expired, superseded and wrong-channel codes, so a caller can't tell
 * which case it hit.
 */
export const INVALID_LINK_CODE = "Link code is invalid or expired";
export const EXTERNAL_ALREADY_LINKED = "This chat account is already linked to a DALVA account";
export const USER_ALREADY_LINKED = "This DALVA account is already linked to another chat account";
export const CHANNEL_ALREADY_LINKED = "Channel is already linked. Unlink it first";
export const IDENTITY_NOT_FOUND = "Channel identity not found";
export const PRIVATE_CHAT_REQUIRED = "Link codes must be sent in a private chat with the bot";

/* Codes -------------------------------------------------------------------- */

export function generateLinkCode(): string {
  return randomBytes(LINK_CODE_BYTES).toString("base64url");
}

/** 256 bits of entropy, so a plain SHA-256 is enough. Lookups go by hash: the raw code is never stored. */
export function hashLinkCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/* Lookups ------------------------------------------------------------------ */

const active = isNull(channelIdentities.unlinkedAt);

async function findActiveByExternal(tx: Tx, channel: Channel, externalUserId: string): Promise<ChannelIdentity | null> {
  const [identity] = await tx
    .select()
    .from(channelIdentities)
    .where(and(eq(channelIdentities.channel, channel), eq(channelIdentities.externalUserId, externalUserId), active))
    .limit(1);
  return identity ?? null;
}

async function findActiveByUser(tx: Tx, userId: string, channel: Channel): Promise<ChannelIdentity | null> {
  const [identity] = await tx
    .select()
    .from(channelIdentities)
    .where(and(eq(channelIdentities.userId, userId), eq(channelIdentities.channel, channel), active))
    .limit(1);
  return identity ?? null;
}

/** Active links of a user (at most one per channel), oldest first. */
export async function listActiveForUser(tx: Tx, userId: string): Promise<ChannelIdentity[]> {
  return await tx
    .select()
    .from(channelIdentities)
    .where(and(eq(channelIdentities.userId, userId), active))
    .orderBy(asc(channelIdentities.linkedAt), asc(channelIdentities.id))
    .limit(LIST_LIMIT);
}

/** The user's active identity `identityId`, or `IDENTITY_NOT_FOUND` (missing, someone else's or unlinked). */
async function requireOwnedActive(tx: Tx, userId: string, identityId: string): Promise<ChannelIdentity> {
  const [identity] = await tx
    .select()
    .from(channelIdentities)
    .where(and(eq(channelIdentities.id, identityId), eq(channelIdentities.userId, userId), active))
    .limit(1);
  if (!identity) throw new DomainError("not_found", IDENTITY_NOT_FOUND);
  return identity;
}

/* Linking ------------------------------------------------------------------ */

/**
 * Store a new code for the user. Every previous code for the channel is
 * deleted (used ones too: a deleted code fails redeem exactly like a used one),
 * so only the latest code works and there is at most one row per user and channel.
 */
export async function storeLinkCode(
  tx: Tx,
  userId: string,
  args: { channel: Channel; codeHash: string; now: Date },
): Promise<{ expiresAt: Date }> {
  if (await findActiveByUser(tx, userId, args.channel)) throw conflict(CHANNEL_ALREADY_LINKED);
  await tx.delete(channelLinkCodes).where(and(eq(channelLinkCodes.userId, userId), eq(channelLinkCodes.channel, args.channel)));
  const expiresAt = new Date(args.now.getTime() + LINK_CODE_TTL_MS);
  await tx.insert(channelLinkCodes).values({
    userId,
    channel: args.channel,
    codeHash: args.codeHash,
    expiresAt,
    // The web app only sends `consent: true`; it is given when the code is created.
    consentAt: args.now,
  });
  return { expiresAt };
}

/**
 * Consume a code and link the chat account to the code's owner. One
 * SERIALIZABLE transaction: two concurrent redeems of one code, or for one
 * chat account, conflict and rerun, and the second sees the first's write.
 */
export async function redeemLinkCode(
  tx: Tx,
  args: { codeHash: string; channel: Channel; externalUserId: string; chatId: string; username?: string; now: Date },
): Promise<ChannelIdentity> {
  const [code] = await tx.select().from(channelLinkCodes).where(eq(channelLinkCodes.codeHash, args.codeHash)).limit(1);
  if (!code || code.usedAt !== null || code.expiresAt <= args.now || code.channel !== args.channel) {
    throw new DomainError("not_found", INVALID_LINK_CODE);
  }
  // Telegram private chats share the user's id; anything else is a group or channel,
  // where the bot would later answer finance questions in front of other members.
  if (args.channel === "telegram" && args.chatId !== args.externalUserId) {
    throw new DomainError("validation_failed", PRIVATE_CHAT_REQUIRED);
  }
  const userId = code.userId; // the only source of the user: the server-side code row

  if (await findActiveByExternal(tx, args.channel, args.externalUserId)) throw conflict(EXTERNAL_ALREADY_LINKED);
  if (await findActiveByUser(tx, userId, args.channel)) throw conflict(USER_ALREADY_LINKED);

  await tx.update(channelLinkCodes).set({ usedAt: args.now }).where(eq(channelLinkCodes.id, code.id));
  const [identity] = await tx
    .insert(channelIdentities)
    .values({
      userId,
      channel: args.channel,
      externalUserId: args.externalUserId,
      chatId: args.chatId,
      username: args.username ?? null,
      scopes: READ_WRITE_SCOPES,
      linkedAt: args.now,
      consentAt: code.consentAt,
    })
    .returning();
  return identity!;
}

/** The active identity of a chat sender, only when the message comes from the linked chat. */
export async function resolveIdentity(
  tx: Tx,
  args: { channel: Channel; externalUserId: string; chatId: string },
): Promise<{ identity: ChannelIdentity; displayName?: string; baseCurrency?: string } | null> {
  const identity = await findActiveByExternal(tx, args.channel, args.externalUserId);
  if (!identity || identity.chatId !== args.chatId) return null;
  const [owner] = await tx
    .select({ name: users.name, baseCurrency: userProfiles.baseCurrency })
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(eq(users.id, identity.userId))
    .limit(1);
  if (!owner) return null;
  return {
    identity,
    ...(owner.name ? { displayName: owner.name } : {}),
    ...(owner.baseCurrency ? { baseCurrency: owner.baseCurrency } : {}),
  };
}

/* Unlinking and read-only -------------------------------------------------- */

/** From the chat (`/unlink`). Unlinking also deletes the identity's chat history. */
export async function unlinkByExternal(tx: Tx, channel: Channel, externalUserId: string, now: Date): Promise<string> {
  const identity = await findActiveByExternal(tx, channel, externalUserId);
  if (!identity) throw new DomainError("not_found", IDENTITY_NOT_FOUND);
  await unlink(tx, identity, now);
  return identity.id;
}

/** From the web app. */
export async function unlinkForUser(tx: Tx, userId: string, identityId: string, now: Date): Promise<void> {
  await unlink(tx, await requireOwnedActive(tx, userId, identityId), now);
}

async function unlink(tx: Tx, identity: ChannelIdentity, now: Date): Promise<void> {
  await tx.update(channelIdentities).set({ unlinkedAt: now }).where(eq(channelIdentities.id, identity.id));
  await deleteIdentityHistory(tx, identity.userId, identity.id);
}

/** Read-only keeps `finance:read` only; tokens already minted follow on their next request. */
export async function setReadOnly(tx: Tx, userId: string, identityId: string, readOnly: boolean): Promise<ChannelIdentity> {
  const identity = await requireOwnedActive(tx, userId, identityId);
  const [updated] = await tx
    .update(channelIdentities)
    .set({ scopes: readOnly ? READ_ONLY_SCOPES : READ_WRITE_SCOPES })
    .where(eq(channelIdentities.id, identity.id))
    .returning();
  return updated!;
}

/**
 * Why a token minted for a chat identity can't be used now: `revoked` when the
 * identity is gone, someone else's or unlinked; `scope` when it no longer holds
 * the finance scope the route needs (switched to read-only). Run it in the
 * same transaction as the read or write it guards.
 */
export async function channelTokenProblem(
  tx: Tx,
  userId: string,
  channelIdentityId: string,
  required: TokenScope,
): Promise<"revoked" | "scope" | null> {
  const [identity] = await tx
    .select({ scopes: channelIdentities.scopes, unlinkedAt: channelIdentities.unlinkedAt })
    .from(channelIdentities)
    .where(and(eq(channelIdentities.id, channelIdentityId), eq(channelIdentities.userId, userId)))
    .limit(1);
  if (!identity || identity.unlinkedAt !== null) return "revoked";
  // The identity stores finance scopes only; `agent:state` follows from being linked.
  if (required !== "agent:state" && !identity.scopes.includes(required)) return "scope";
  return null;
}

/* Retention ---------------------------------------------------------------- */

/** Delete one batch of codes (used or not) whose TTL has passed. Returns how many. */
export async function purgeExpiredCodes(db: Database, now: Date, batch: number): Promise<number> {
  const expired = db.select({ id: channelLinkCodes.id }).from(channelLinkCodes).where(lt(channelLinkCodes.expiresAt, now)).limit(batch);
  const deleted = await db
    .delete(channelLinkCodes)
    .where(inArray(channelLinkCodes.id, expired))
    .returning({ id: channelLinkCodes.id });
  return deleted.length;
}
