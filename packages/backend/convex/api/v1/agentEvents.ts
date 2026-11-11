import { v } from "convex/values";

import type { Doc } from "../../_generated/dataModel";
import { internalMutation, internalQuery } from "../../_generated/server";
import * as agentStore from "../../domain/agentStore";
import { channelValidator } from "../../schema";
import { mapDomainErrors } from "./errors";

/*
 * Internal functions behind the agent's service routes (inbound events). The
 * httpAction calls them only after the service key checked out. Events are
 * handled before any identity is resolved, so none of them knows a user.
 */

const iso = (ms: number) => new Date(ms).toISOString();

const eventDto = (event: Doc<"agentInboundEvents">) => ({
  channel: event.channel,
  eventId: event.eventId,
  status: event.status,
  attempts: event.attempts,
  ...(event.error === undefined ? {} : { error: event.error }),
  receivedAt: iso(event.receivedAt),
  updatedAt: iso(event.updatedAt),
});

export const claim = internalMutation({
  args: { channel: channelValidator, eventId: v.string(), payload: v.string() },
  handler: async (ctx, args) => ({ status: await agentStore.claimEvent(ctx, { ...args, now: Date.now() }) }),
});

export const updateStatus = internalMutation({
  args: {
    channel: channelValidator,
    eventId: v.string(),
    status: v.union(v.literal("processing"), v.literal("done"), v.literal("failed")),
    error: v.optional(v.string()),
  },
  handler: (ctx, args) =>
    mapDomainErrors(async () => ({ event: eventDto(await agentStore.updateEventStatus(ctx, { ...args, now: Date.now() })) })),
});

export const listRecoverable = internalQuery({
  args: { channel: channelValidator, olderThanSeconds: v.number(), maxAttempts: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    const events = await agentStore.listRecoverableEvents(ctx, {
      channel: args.channel,
      olderThanMs: args.olderThanSeconds * 1000,
      maxAttempts: args.maxAttempts,
      limit: args.limit,
      now: Date.now(),
    });
    return { items: events.map((event) => ({ ...eventDto(event), payload: event.payload })) };
  },
});
