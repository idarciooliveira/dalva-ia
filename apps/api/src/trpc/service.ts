/**
 * Service procedures: the chat agent's own credential (the service key), for
 * what happens before a chat has a user token (linking, resolving, inbound
 * events). They act for no user; each finds the user from server state.
 */
import { AGENT_EVENT_PAYLOAD_MAX_BYTES, linkCodeSchema } from "@mpf/shared";
import { z } from "zod";

import { AGENT_STATE_SCOPE, TOKEN_SCOPES, type TokenScope } from "../auth/tokens";
import { agentEventStatus, channelScope } from "../db/schema";
import * as agentStore from "../domain/agentStore";
import * as channelLinks from "../domain/channelLinks";
import { notFound } from "../domain/errors";
import { channelSchema } from "./chatLinks";
import { iso } from "./dto";
import { router, serviceRead, serviceWrite } from "./init";
import { externalIdSchema, jsonString } from "./json";
import { deleted } from "./schemas";

export const RESOLVED_TOKEN_TTL_SECONDS = 15 * 60;

export const channelIdentitySchema = z.object({
  id: z.string(),
  channel: channelSchema,
  externalUserId: z.string(),
  chatId: z.string(),
  username: z.string().optional(),
  scopes: z.array(z.enum(channelScope.enumValues)),
  /** ISO 8601. */
  linkedAt: z.string(),
  consentAt: z.string(),
});

const agentEventSchema = z.object({
  channel: channelSchema,
  eventId: z.string(),
  status: z.enum(agentEventStatus.enumValues),
  attempts: z.number().int(),
  error: z.string().optional(),
  receivedAt: z.string(),
  updatedAt: z.string(),
});

/** Platform event id (Telegram `update_id`). */
const agentEventIdSchema = z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/, "Invalid event id");

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

export const channelLinksRouter = router({
  /** `/start <code>` from a chat: link it to the user who created the code. */
  redeem: serviceWrite
    .input(
      z.strictObject({
        channel: channelSchema,
        code: linkCodeSchema,
        externalUserId: externalIdSchema,
        chatId: externalIdSchema,
        username: z.string().min(1).max(64).optional(),
      }),
    )
    .output(z.object({ identity: channelIdentitySchema }))
    .mutation(async ({ ctx, input }) => {
      const { code, ...rest } = input;
      const identity = await channelLinks.redeemLinkCode(ctx.tx, { ...rest, codeHash: channelLinks.hashLinkCode(code), now: new Date() });
      return { identity: identityDto(identity) };
    }),
});

export const channelIdentitiesRouter = router({
  /**
   * A chat sender -> a short-lived user token. `chatId` must be the chat the
   * identity was linked from (`not_found` otherwise), so a user's data is
   * never served into another chat (a group).
   */
  resolve: serviceWrite
    .input(z.strictObject({ channel: channelSchema, externalUserId: externalIdSchema, chatId: externalIdSchema }))
    .output(
      z.object({
        /** `Authorization: Bearer <token>` for the user procedures. */
        token: z.string(),
        /** ISO 8601; mint a new one on the next message rather than caching past this. */
        expiresAt: z.string(),
        /** The identity's finance scopes plus `agent:state`. */
        scopes: z.array(z.enum(TOKEN_SCOPES)),
        identity: channelIdentitySchema,
        profile: z.object({ displayName: z.string().optional(), baseCurrency: z.string().optional() }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const found = await channelLinks.resolveIdentity(ctx.tx, input);
      if (!found) throw notFound("Channel identity");
      const now = Math.floor(Date.now() / 1000);
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

  unlink: serviceWrite
    .input(z.strictObject({ channel: channelSchema, externalUserId: externalIdSchema }))
    .output(deleted)
    .mutation(async ({ ctx, input }) => ({
      id: await channelLinks.unlinkByExternal(ctx.tx, input.channel, input.externalUserId, new Date()),
    })),
});

export const agentEventsRouter = router({
  /**
   * The first thing the agent does with a platform event, before resolving
   * the identity: `new` means process it, `duplicate` means drop it. A
   * duplicate never finished is picked up by `listRecoverable` on boot.
   */
  claim: serviceWrite
    .input(
      z.strictObject({
        channel: channelSchema,
        eventId: agentEventIdSchema,
        /** The raw event as JSON, kept so a crashed event can be re-processed. Dropped once `done`. */
        payload: jsonString(AGENT_EVENT_PAYLOAD_MAX_BYTES),
      }),
    )
    .output(z.object({ status: z.enum(["new", "duplicate"]) }))
    .mutation(async ({ ctx, input }) => ({ status: await agentStore.claimEvent(ctx.tx, { ...input, now: new Date() }) })),

  /** `processing` counts one attempt. `done` and `failed` are final (`conflict` after); unknown is `not_found`. */
  updateStatus: serviceWrite
    .input(
      z.strictObject({
        channel: channelSchema,
        eventId: agentEventIdSchema,
        status: z.enum(["processing", "done", "failed"]),
        error: z.string().max(500).optional(),
      }),
    )
    .output(z.object({ event: agentEventSchema }))
    .mutation(async ({ ctx, input }) => ({ event: eventDto(await agentStore.updateEventStatus(ctx.tx, { ...input, now: new Date() })) })),

  /** Events stuck in `received`/`processing` with no update for `olderThanSeconds`, oldest first. */
  listRecoverable: serviceRead
    .input(
      z.strictObject({
        channel: channelSchema,
        olderThanSeconds: z.number().int().min(0).max(86_400).default(60),
        maxAttempts: z.number().int().min(1).max(20).default(3),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    )
    .output(z.object({ items: z.array(agentEventSchema.extend({ payload: z.string() })) }))
    .query(async ({ ctx, input }) => {
      const events = await agentStore.listRecoverableEvents(ctx.tx, {
        channel: input.channel,
        olderThanMs: input.olderThanSeconds * 1000,
        maxAttempts: input.maxAttempts,
        limit: input.limit,
        now: new Date(),
      });
      return { items: events.map((event) => ({ ...eventDto(event), payload: event.payload })) };
    }),
});
