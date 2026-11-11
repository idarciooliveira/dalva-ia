import { v } from "convex/values";

import type { Doc } from "../../_generated/dataModel";
import { internalMutation, internalQuery } from "../../_generated/server";
import * as channelLinks from "../../domain/channelLinks";
import { channelValidator } from "../../schema";
import { mapDomainErrors } from "./errors";

/*
 * Internal functions behind the service routes. The httpAction calls them
 * only after the service key checked out. None takes a userId: the user comes
 * from the code row (redeem) or the linked identity (resolve, unlink).
 */

export const identityDto = (identity: Doc<"channelIdentities">) => ({
  id: identity._id as string,
  channel: identity.channel,
  externalUserId: identity.externalUserId,
  chatId: identity.chatId,
  ...(identity.username ? { username: identity.username } : {}),
  scopes: identity.scopes,
  linkedAt: new Date(identity.linkedAt).toISOString(),
  consentAt: new Date(identity.consentAt).toISOString(),
});

export const redeem = internalMutation({
  args: {
    codeHash: v.string(),
    channel: channelValidator,
    externalUserId: v.string(),
    chatId: v.string(),
    username: v.optional(v.string()),
  },
  handler: (ctx, args) =>
    mapDomainErrors(async () => {
      const identity = await channelLinks.redeemLinkCode(ctx, { ...args, now: Date.now() });
      return { identity: identityDto(identity) };
    }),
});

export const lookup = internalQuery({
  args: { channel: channelValidator, externalUserId: v.string(), chatId: v.string() },
  handler: async (ctx, args) => {
    const found = await channelLinks.resolveIdentity(ctx, args);
    if (!found) return null;
    return {
      userId: found.identity.userId,
      identity: identityDto(found.identity),
      profile: {
        ...(found.displayName ? { displayName: found.displayName } : {}),
        ...(found.baseCurrency ? { baseCurrency: found.baseCurrency } : {}),
      },
    };
  },
});

export const unlink = internalMutation({
  args: { channel: channelValidator, externalUserId: v.string() },
  handler: (ctx, args) =>
    mapDomainErrors(async () => {
      const id = await channelLinks.unlinkByExternal(ctx, args.channel, args.externalUserId, Date.now());
      return { id: id as string };
    }),
});
