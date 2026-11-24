/**
 * Service routes: the chat agent with its service key, acting for no user.
 * None takes a user id: the user comes from the code row (redeem) or the
 * linked identity (resolve, unlink). Inbound events run before any identity
 * is resolved, so they know no user at all.
 */
import { AGENT_STATE_SCOPE, routes, type TokenScope } from "@mpf/finance-contract";

import * as agentStore from "../../domain/agentStore";
import * as channelLinks from "../../domain/channelLinks";
import { notFound } from "../../domain/errors";
import { serviceOperation } from "../operation";
import { iso } from "./shared";

/** Lifetime of a token minted by `channelIdentities.resolve`. */
export const RESOLVED_TOKEN_TTL_SECONDS = 15 * 60;

const identityDto = (identity: channelLinks.ChannelIdentity) => ({
  id: identity.id,
  channel: identity.channel,
  externalUserId: identity.externalUserId,
  chatId: identity.chatId,
  ...(identity.username ? { username: identity.username } : {}),
  scopes: identity.scopes,
  linkedAt: iso(identity.linkedAt),
  consentAt: iso(identity.consentAt),
});

const eventDto = (event: agentStore.AgentEvent) => ({
  channel: event.channel,
  eventId: event.eventId,
  status: event.status,
  attempts: event.attempts,
  ...(event.error === null ? {} : { error: event.error }),
  receivedAt: iso(event.receivedAt),
  updatedAt: iso(event.updatedAt),
});

export const channelLinkServiceOperations = {
  redeem: serviceOperation(routes.channelLinks.redeem, async (tx, _ctx, input) => {
    const { code, ...rest } = input;
    const identity = await channelLinks.redeemLinkCode(tx, { ...rest, codeHash: channelLinks.hashLinkCode(code), now: new Date() });
    return { identity: identityDto(identity) };
  }),
};

export const channelIdentityServiceOperations = {
  resolve: serviceOperation(routes.channelIdentities.resolve, async (tx, ctx, input) => {
    const found = await channelLinks.resolveIdentity(tx, input);
    if (!found) throw notFound("Channel identity");
    const now = Math.floor(Date.now() / 1000);
    // `agent:state` is always granted: read-only users keep their conversation state.
    const scopes: TokenScope[] = [...found.identity.scopes, AGENT_STATE_SCOPE];
    const token = await ctx.tokens.mint(found.identity.userId, scopes, RESOLVED_TOKEN_TTL_SECONDS, {
      now,
      channelIdentityId: found.identity.id,
    });
    return {
      token,
      expiresAt: new Date((now + RESOLVED_TOKEN_TTL_SECONDS) * 1000).toISOString(),
      scopes,
      identity: identityDto(found.identity),
      profile: {
        ...(found.displayName ? { displayName: found.displayName } : {}),
        ...(found.baseCurrency ? { baseCurrency: found.baseCurrency } : {}),
      },
    };
  }),

  unlink: serviceOperation(routes.channelIdentities.unlink, async (tx, _ctx, input) => {
    return { id: await channelLinks.unlinkByExternal(tx, input.channel, input.externalUserId, new Date()) };
  }),
};

export const agentEventServiceOperations = {
  claim: serviceOperation(routes.agentEvents.claim, async (tx, _ctx, input) => {
    return { status: await agentStore.claimEvent(tx, { ...input, now: new Date() }) };
  }),

  updateStatus: serviceOperation(routes.agentEvents.updateStatus, async (tx, _ctx, input) => {
    return { event: eventDto(await agentStore.updateEventStatus(tx, { ...input, now: new Date() })) };
  }),

  listRecoverable: serviceOperation(routes.agentEvents.listRecoverable, async (tx, _ctx, input) => {
    const events = await agentStore.listRecoverableEvents(tx, {
      channel: input.channel,
      olderThanMs: input.olderThanSeconds * 1000,
      maxAttempts: input.maxAttempts,
      limit: input.limit,
      now: new Date(),
    });
    return { items: events.map((event) => ({ ...eventDto(event), payload: event.payload })) };
  }),
};
