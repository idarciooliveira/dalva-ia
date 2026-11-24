import { createHash, randomBytes } from "node:crypto";

import type { TokenScope } from "../auth/tokens";
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
const LIST_LIMIT = 20;

export const INVALID_LINK_CODE = "Link code is invalid or expired";
export const EXTERNAL_ALREADY_LINKED = "This chat account is already linked to a DALVA account";
export const USER_ALREADY_LINKED = "This DALVA account is already linked to another chat account";
export const CHANNEL_ALREADY_LINKED = "Channel is already linked. Unlink it first";
export const IDENTITY_NOT_FOUND = "Channel identity not found";
export const PRIVATE_CHAT_REQUIRED = "Link codes must be sent in a private chat with the bot";

export function generateLinkCode(): string {
  return randomBytes(LINK_CODE_BYTES).toString("base64url");
}

export function hashLinkCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

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

export async function listActiveForUser(tx: Tx, userId: string): Promise<ChannelIdentity[]> {
  return await tx
    .select()
    .from(channelIdentities)
    .where(and(eq(channelIdentities.userId, userId), active))
    .orderBy(asc(channelIdentities.linkedAt), asc(channelIdentities.id))
    .limit(LIST_LIMIT);
}

async function requireOwnedActive(tx: Tx, userId: string, identityId: string): Promise<ChannelIdentity> {
  const [identity] = await tx
    .select()
    .from(channelIdentities)
    .where(and(eq(channelIdentities.id, identityId), eq(channelIdentities.userId, userId), active))
    .limit(1);
  if (!identity) throw new DomainError("not_found", IDENTITY_NOT_FOUND);
  return identity;
}

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
    consentAt: args.now,
  });
  return { expiresAt };
}

export async function redeemLinkCode(
  tx: Tx,
  args: { codeHash: string; channel: Channel; externalUserId: string; chatId: string; username?: string; now: Date },
): Promise<ChannelIdentity> {
  const [code] = await tx.select().from(channelLinkCodes).where(eq(channelLinkCodes.codeHash, args.codeHash)).limit(1);
  if (!code || code.usedAt !== null || code.expiresAt <= args.now || code.channel !== args.channel) {
    throw new DomainError("not_found", INVALID_LINK_CODE);
  }
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

export async function unlinkByExternal(tx: Tx, channel: Channel, externalUserId: string, now: Date): Promise<string> {
  const identity = await findActiveByExternal(tx, channel, externalUserId);
  if (!identity) throw new DomainError("not_found", IDENTITY_NOT_FOUND);
  await unlink(tx, identity, now);
  return identity.id;
}

export async function unlinkForUser(tx: Tx, userId: string, identityId: string, now: Date): Promise<void> {
  await unlink(tx, await requireOwnedActive(tx, userId, identityId), now);
}

async function unlink(tx: Tx, identity: ChannelIdentity, now: Date): Promise<void> {
  await tx.update(channelIdentities).set({ unlinkedAt: now }).where(eq(channelIdentities.id, identity.id));
  await deleteIdentityHistory(tx, identity.userId, identity.id);
}

export async function setReadOnly(tx: Tx, userId: string, identityId: string, readOnly: boolean): Promise<ChannelIdentity> {
  const identity = await requireOwnedActive(tx, userId, identityId);
  const [updated] = await tx
    .update(channelIdentities)
    .set({ scopes: readOnly ? READ_ONLY_SCOPES : READ_WRITE_SCOPES })
    .where(eq(channelIdentities.id, identity.id))
    .returning();
  return updated!;
}

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
  if (required !== "agent:state" && !identity.scopes.includes(required)) return "scope";
  return null;
}

export async function purgeExpiredCodes(db: Database, now: Date, batch: number): Promise<number> {
  const expired = db.select({ id: channelLinkCodes.id }).from(channelLinkCodes).where(lt(channelLinkCodes.expiresAt, now)).limit(batch);
  const deleted = await db
    .delete(channelLinkCodes)
    .where(and(inArray(channelLinkCodes.id, expired), lt(channelLinkCodes.expiresAt, now)))
    .returning({ id: channelLinkCodes.id });
  return deleted.length;
}
