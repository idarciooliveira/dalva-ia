import { AGENT_SESSION_MAX_MESSAGES } from "@mpf/finance-contract";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/*
 * State for the chat agent: inbound events, sessions, messages and pending
 * actions. Every function here takes the already-authenticated userId and
 * identity from the API layer; none of them trusts an id that came from a
 * client without checking ownership. Error messages are mapped to API codes
 * in api/v1/errors.ts.
 */

type Channel = Doc<"channelIdentities">["channel"];
type EventStatus = Doc<"agentInboundEvents">["status"];
type ActionStatus = Doc<"agentPendingActions">["status"];

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** Inbound events (they hold message text) are deleted this long after their last update. */
export const EVENT_RETENTION_MS = DAY_MS;
/** Sessions without activity, and finished actions, are deleted after this long. */
export const SESSION_RETENTION_MS = 30 * DAY_MS;
export const DEFAULT_ACTION_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_PER_SESSION = 20;
export const MAX_SESSION_MESSAGES = AGENT_SESSION_MAX_MESSAGES;

/** Rows one transaction may delete when clearing history (the rest continues through the scheduler). */
export const HISTORY_DELETE_BUDGET = 500;
/** Rows one cron run may delete or update. */
export const PURGE_BATCH = 200;
/**
 * `_creationTime` is monotonic and can sit a fraction above `Date.now()` when
 * several documents land in the same millisecond. The deletion cutoff gets this
 * margin so history written just before the request is never left behind
 * (the cost: something created within 1 ms after the request would go too).
 */
const CUTOFF_MARGIN_MS = 1;
/** Rows read per `listRecoverable` call before filtering by attempts. */
const RECOVERABLE_SCAN = 100;

export const EVENT_NOT_FOUND = "Event not found";
export const EVENT_FINISHED = "Event is already finished";
export const SESSION_NOT_FOUND = "Session not found";
export const SESSION_ENDED = "Session has ended";
export const SESSION_FULL = "Session has reached its message limit";
export const CHAT_MISMATCH = "Chat does not match the linked chat";
export const ACTION_NOT_FOUND = "Pending action not found";
export const TOO_MANY_PENDING = "Too many pending actions in this session";
export const ACTION_NOT_CONFIRMED = "Pending action is not confirmed";

const EVENT_STATUSES: EventStatus[] = ["received", "processing", "done", "failed"];

/* -------------------------------------------------------------------------- */
/*  Inbound events                                                            */
/* -------------------------------------------------------------------------- */

async function findEvent(ctx: QueryCtx, channel: Channel, eventId: string) {
  return await ctx.db
    .query("agentInboundEvents")
    .withIndex("by_channel_and_eventId", (q) => q.eq("channel", channel).eq("eventId", eventId))
    .unique();
}

/** First claim of an event wins (`new`); later ones are `duplicate` and change nothing. */
export async function claimEvent(
  ctx: MutationCtx,
  args: { channel: Channel; eventId: string; payload: string; now: number },
): Promise<"new" | "duplicate"> {
  if (await findEvent(ctx, args.channel, args.eventId)) return "duplicate";
  await ctx.db.insert("agentInboundEvents", {
    channel: args.channel,
    eventId: args.eventId,
    status: "received",
    attempts: 0,
    payload: args.payload,
    receivedAt: args.now,
    updatedAt: args.now,
  });
  return "new";
}

/**
 * `processing` counts an attempt. `done` and `failed` are final and drop the
 * payload: it is message text, and nothing re-processes a finished event.
 */
export async function updateEventStatus(
  ctx: MutationCtx,
  args: { channel: Channel; eventId: string; status: "processing" | "done" | "failed"; error?: string; now: number },
) {
  const event = await findEvent(ctx, args.channel, args.eventId);
  if (!event) throw new Error(EVENT_NOT_FOUND);
  if (event.status === "done" || event.status === "failed") throw new Error(EVENT_FINISHED);

  const patch: Partial<Doc<"agentInboundEvents">> = { status: args.status, updatedAt: args.now };
  if (args.status === "processing") patch.attempts = event.attempts + 1;
  else patch.payload = "";
  if (args.status === "failed" && args.error) patch.error = args.error;
  await ctx.db.patch(event._id, patch);
  return (await ctx.db.get(event._id))!;
}

/** Stuck events, oldest first, that still have attempts left. Reads at most `RECOVERABLE_SCAN` rows per status. */
export async function listRecoverableEvents(
  ctx: QueryCtx,
  args: { channel: Channel; olderThanMs: number; maxAttempts: number; limit: number; now: number },
) {
  const cutoff = args.now - args.olderThanMs;
  const stuck: Doc<"agentInboundEvents">[] = [];
  for (const status of ["received", "processing"] as const) {
    const rows = await ctx.db
      .query("agentInboundEvents")
      .withIndex("by_channel_and_status_and_updatedAt", (q) =>
        q.eq("channel", args.channel).eq("status", status).lt("updatedAt", cutoff),
      )
      .take(RECOVERABLE_SCAN);
    stuck.push(...rows.filter((event) => event.attempts < args.maxAttempts));
  }
  return stuck.sort((a, b) => a.updatedAt - b.updatedAt).slice(0, args.limit);
}

/** Delete events untouched since `cutoff`, whatever their status. Returns how many. */
export async function purgeStaleEvents(ctx: MutationCtx, cutoff: number, batch: number): Promise<number> {
  let deleted = 0;
  for (const status of EVENT_STATUSES) {
    if (deleted >= batch) break;
    const rows = await ctx.db
      .query("agentInboundEvents")
      .withIndex("by_status_and_updatedAt", (q) => q.eq("status", status).lt("updatedAt", cutoff))
      .take(batch - deleted);
    for (const row of rows) await ctx.db.delete(row._id);
    deleted += rows.length;
  }
  return deleted;
}

/* -------------------------------------------------------------------------- */
/*  Sessions and messages                                                     */
/* -------------------------------------------------------------------------- */

/** A session of this user and identity, or `SESSION_NOT_FOUND` (never says whether it exists for someone else). */
export async function loadSession(
  ctx: QueryCtx,
  userId: string,
  identityId: Id<"channelIdentities">,
  rawId: string,
): Promise<Doc<"agentSessions">> {
  const id = ctx.db.normalizeId("agentSessions", rawId);
  const session = id ? await ctx.db.get(id) : null;
  if (!session || session.userId !== userId || session.identityId !== identityId) throw new Error(SESSION_NOT_FOUND);
  return session;
}

/**
 * The chat's active session. A session idle for longer than `idleMs` (or
 * `startNew`, or one left over from an earlier link) is ended and replaced.
 */
export async function currentSession(
  ctx: MutationCtx,
  args: {
    userId: string;
    identity: Doc<"channelIdentities">;
    chatId: string;
    idleMs: number;
    startNew: boolean;
    now: number;
  },
): Promise<{ session: Doc<"agentSessions">; created: boolean }> {
  const { userId, identity, now } = args;
  const active = await ctx.db
    .query("agentSessions")
    .withIndex("by_userId_and_channel_and_chatId_and_endedAt", (q) =>
      q.eq("userId", userId).eq("channel", identity.channel).eq("chatId", args.chatId).eq("endedAt", undefined),
    )
    .order("desc")
    .take(5);

  const [latest, ...extra] = active;
  // Writes serialize, so there is normally one. Close any stray rather than fail.
  for (const stray of extra) await ctx.db.patch(stray._id, { endedAt: now });

  if (latest) {
    const reusable =
      !args.startNew && latest.identityId === identity._id && now - latest.lastActivityAt <= args.idleMs;
    if (reusable) return { session: latest, created: false };
    await ctx.db.patch(latest._id, { endedAt: now });
  }

  const id = await ctx.db.insert("agentSessions", {
    userId,
    identityId: identity._id,
    channel: identity.channel,
    chatId: args.chatId,
    startedAt: now,
    lastActivityAt: now,
    messageCount: 0,
  });
  return { session: (await ctx.db.get(id))!, created: true };
}

/** The latest `limit` messages, oldest first. */
export async function listMessages(ctx: QueryCtx, sessionId: Id<"agentSessions">, limit: number) {
  const latest = await ctx.db
    .query("agentMessages")
    .withIndex("by_sessionId_and_seq", (q) => q.eq("sessionId", sessionId))
    .order("desc")
    .take(limit);
  return latest.reverse();
}

/** Store a batch in order. All or nothing: an ended or full session stores none of it. */
export async function appendMessages(
  ctx: MutationCtx,
  session: Doc<"agentSessions">,
  messages: Array<{ role: Doc<"agentMessages">["role"]; content: string }>,
  now: number,
) {
  if (session.endedAt !== undefined) throw new Error(SESSION_ENDED);
  if (session.messageCount + messages.length > MAX_SESSION_MESSAGES) throw new Error(SESSION_FULL);

  const ids: Id<"agentMessages">[] = [];
  for (const [i, message] of messages.entries()) {
    ids.push(
      await ctx.db.insert("agentMessages", {
        sessionId: session._id,
        userId: session.userId,
        role: message.role,
        content: message.content,
        seq: session.messageCount + i + 1,
        createdAt: now,
      }),
    );
  }
  await ctx.db.patch(session._id, { messageCount: session.messageCount + messages.length, lastActivityAt: now });
  return (await Promise.all(ids.map((id) => ctx.db.get(id)))).map((doc) => doc!);
}

/* -------------------------------------------------------------------------- */
/*  Pending actions                                                           */
/* -------------------------------------------------------------------------- */

/** An action of this user, in a session of this identity, or `ACTION_NOT_FOUND`. */
export async function loadAction(
  ctx: QueryCtx,
  userId: string,
  identityId: Id<"channelIdentities">,
  rawId: string,
): Promise<Doc<"agentPendingActions">> {
  const id = ctx.db.normalizeId("agentPendingActions", rawId);
  const action = id ? await ctx.db.get(id) : null;
  if (!action || action.userId !== userId) throw new Error(ACTION_NOT_FOUND);
  const session = await ctx.db.get(action.sessionId);
  if (!session || session.identityId !== identityId) throw new Error(ACTION_NOT_FOUND);
  return action;
}

/**
 * At most `MAX_PENDING_PER_SESSION` live pending actions per session. Rows past
 * `expiresAt` that the cron has not reached yet are expired here as they are
 * read, so a pile of them can neither count against the limit nor hide live
 * rows behind them. Bounded: a few small reads, then a conservative refusal.
 */
async function assertRoomForAction(ctx: MutationCtx, sessionId: Id<"agentSessions">, now: number) {
  for (let round = 0; round < 5; round++) {
    const open = await ctx.db
      .query("agentPendingActions")
      .withIndex("by_sessionId_and_status", (q) => q.eq("sessionId", sessionId).eq("status", "pending"))
      .take(MAX_PENDING_PER_SESSION + 1);
    let live = 0;
    for (const action of open) {
      if (action.expiresAt <= now) await ctx.db.patch(action._id, { status: "expired", updatedAt: now });
      else live++;
    }
    if (live >= MAX_PENDING_PER_SESSION) break;
    if (open.length <= MAX_PENDING_PER_SESSION) return; // read them all
  }
  throw new Error(TOO_MANY_PENDING);
}

export async function createPendingAction(
  ctx: MutationCtx,
  session: Doc<"agentSessions">,
  args: { operation: string; input: string; summary: string; ttlMs: number; now: number; clientKey?: string },
) {
  // A repeated create (the caller replayed the same proposal) returns what the first one stored, in any status.
  if (args.clientKey !== undefined) {
    const existing = await ctx.db
      .query("agentPendingActions")
      .withIndex("by_sessionId_and_clientKey", (q) => q.eq("sessionId", session._id).eq("clientKey", args.clientKey))
      .first();
    if (existing) return existing;
  }
  if (session.endedAt !== undefined) throw new Error(SESSION_ENDED);
  await assertRoomForAction(ctx, session._id, args.now);
  const id = await ctx.db.insert("agentPendingActions", {
    userId: session.userId,
    sessionId: session._id,
    ...(args.clientKey !== undefined ? { clientKey: args.clientKey } : {}),
    operation: args.operation,
    input: args.input,
    summary: args.summary,
    status: "pending",
    expiresAt: args.now + args.ttlMs,
    createdAt: args.now,
    updatedAt: args.now,
  });
  return (await ctx.db.get(id))!;
}

export type ActionTransition =
  | { ok: true; action: Doc<"agentPendingActions"> }
  | { ok: false; reason: "expired" | "not_pending"; status: ActionStatus };

/**
 * `pending -> next`, atomically (one serializable mutation, so of two racing
 * calls only one sees `pending`). An expired action is marked `expired` and
 * reported as a failure value rather than thrown, so the mark is committed.
 */
export async function transitionPending(
  ctx: MutationCtx,
  action: Doc<"agentPendingActions">,
  next: "confirmed" | "cancelled",
  now: number,
): Promise<ActionTransition> {
  if (action.status !== "pending") return { ok: false, reason: "not_pending", status: action.status };
  if (action.expiresAt <= now) {
    await ctx.db.patch(action._id, { status: "expired", updatedAt: now });
    return { ok: false, reason: "expired", status: "expired" };
  }
  await ctx.db.patch(action._id, { status: next, updatedAt: now });
  return { ok: true, action: (await ctx.db.get(action._id))! };
}

/** `confirmed -> executed | failed`. */
export async function completeAction(
  ctx: MutationCtx,
  action: Doc<"agentPendingActions">,
  status: "executed" | "failed",
  result: string,
  now: number,
) {
  if (action.status !== "confirmed") throw new Error(ACTION_NOT_CONFIRMED);
  await ctx.db.patch(action._id, { status, result, updatedAt: now });
  return (await ctx.db.get(action._id))!;
}

/** Mark pending actions past `expiresAt` as expired. Returns how many. */
export async function expirePendingActions(ctx: MutationCtx, now: number, batch: number): Promise<number> {
  const due = await ctx.db
    .query("agentPendingActions")
    .withIndex("by_status_and_expiresAt", (q) => q.eq("status", "pending").lt("expiresAt", now))
    .take(batch);
  for (const action of due) await ctx.db.patch(action._id, { status: "expired", updatedAt: now });
  return due.length;
}

/* -------------------------------------------------------------------------- */
/*  Deleting history                                                          */
/* -------------------------------------------------------------------------- */

type HistoryScope = { userId: string } | { identityId: Id<"channelIdentities"> };

const CHILD_PAGE = 100;

/**
 * Delete a session's messages and actions, then the session, spending at most
 * `budget` deletes. `done` is false when the budget ran out first.
 */
async function deleteSessionCascade(ctx: MutationCtx, sessionId: Id<"agentSessions">, budget: number) {
  let used = 0;
  for (;;) {
    const take = Math.min(CHILD_PAGE, budget - used);
    if (take <= 0) return { used, done: false };
    const rows = await ctx.db
      .query("agentMessages")
      .withIndex("by_sessionId_and_seq", (q) => q.eq("sessionId", sessionId))
      .take(take);
    for (const row of rows) await ctx.db.delete(row._id);
    used += rows.length;
    if (rows.length < take) break;
  }
  for (;;) {
    const take = Math.min(CHILD_PAGE, budget - used);
    if (take <= 0) return { used, done: false };
    const rows = await ctx.db
      .query("agentPendingActions")
      .withIndex("by_sessionId_and_status", (q) => q.eq("sessionId", sessionId))
      .take(take);
    for (const row of rows) await ctx.db.delete(row._id);
    used += rows.length;
    if (rows.length < take) break;
  }
  if (budget - used <= 0) return { used, done: false };
  await ctx.db.delete(sessionId);
  return { used: used + 1, done: true };
}

/**
 * End every session of the scope that still accepts writes. Deleting history
 * can take several transactions; in the meantime a session that is about to be
 * deleted must refuse new messages and actions (`SESSION_ENDED`), and
 * `currentSession` must start a fresh one instead of reusing it.
 */
async function endActiveSessions(ctx: MutationCtx, scope: HistoryScope, now: number) {
  for (;;) {
    const active =
      "userId" in scope
        ? await ctx.db
            .query("agentSessions")
            .withIndex("by_userId_and_endedAt", (q) => q.eq("userId", scope.userId).eq("endedAt", undefined))
            .take(20)
        : await ctx.db
            .query("agentSessions")
            .withIndex("by_identityId_and_endedAt", (q) => q.eq("identityId", scope.identityId).eq("endedAt", undefined))
            .take(20);
    for (const session of active) await ctx.db.patch(session._id, { endedAt: now });
    if (active.length < 20) return;
  }
}

/**
 * Delete up to `budget` rows of a user's or an identity's history, limited to
 * rows created at or before `before` (when the deletion was requested), so
 * whatever the user does afterwards is never touched. `more` is true when
 * rows may remain, so the caller can schedule another batch.
 */
export async function deleteHistoryBatch(
  ctx: MutationCtx,
  scope: HistoryScope,
  before: number,
  budget: number,
): Promise<{ used: number; more: boolean }> {
  let left = budget;
  for (;;) {
    const sessions =
      "userId" in scope
        ? await ctx.db
            .query("agentSessions")
            .withIndex("by_userId", (q) => q.eq("userId", scope.userId).lte("_creationTime", before))
            .take(20)
        : await ctx.db
            .query("agentSessions")
            .withIndex("by_identityId", (q) => q.eq("identityId", scope.identityId).lte("_creationTime", before))
            .take(20);
    if (sessions.length === 0) break;
    for (const session of sessions) {
      const result = await deleteSessionCascade(ctx, session._id, left);
      left -= result.used;
      if (!result.done || left <= 0) return { used: budget - left, more: true };
    }
  }

  if ("userId" in scope) {
    // Actions whose session row is gone (nothing creates these, but history deletion must not miss them).
    for (;;) {
      const take = Math.min(CHILD_PAGE, left);
      if (take <= 0) return { used: budget - left, more: true };
      const rows = await ctx.db
        .query("agentPendingActions")
        .withIndex("by_userId", (q) => q.eq("userId", scope.userId).lte("_creationTime", before))
        .take(take);
      for (const row of rows) await ctx.db.delete(row._id);
      left -= rows.length;
      if (rows.length < take) break;
    }
  }
  return { used: budget - left, more: false };
}

/**
 * Delete a user's history (every channel): sessions are ended now, the first
 * batch is deleted now, the rest through the scheduler. Only history that
 * exists at this moment is deleted.
 */
export async function deleteUserHistory(ctx: MutationCtx, userId: string): Promise<void> {
  const requestedAt = Date.now();
  await endActiveSessions(ctx, { userId }, requestedAt);
  const before = requestedAt + CUTOFF_MARGIN_MS;
  const { more } = await deleteHistoryBatch(ctx, { userId }, before, HISTORY_DELETE_BUDGET);
  if (more) await ctx.scheduler.runAfter(0, internal.agentStore.purgeUserHistory, { userId, before });
}

/** Delete an identity's history, e.g. when it is unlinked. Same rules as `deleteUserHistory`. */
export async function deleteIdentityHistory(ctx: MutationCtx, identityId: Id<"channelIdentities">): Promise<void> {
  const requestedAt = Date.now();
  await endActiveSessions(ctx, { identityId }, requestedAt);
  const before = requestedAt + CUTOFF_MARGIN_MS;
  const { more } = await deleteHistoryBatch(ctx, { identityId }, before, HISTORY_DELETE_BUDGET);
  if (more) await ctx.scheduler.runAfter(0, internal.agentStore.purgeIdentityHistory, { identityId, before });
}

/**
 * Retention: delete sessions with no activity since `now - SESSION_RETENTION_MS`
 * (with their messages and actions), and finished or stale actions of that age.
 */
export async function purgeInactiveHistory(
  ctx: MutationCtx,
  now: number,
  budget: number,
): Promise<{ used: number; more: boolean }> {
  const cutoff = now - SESSION_RETENTION_MS;
  let left = budget;

  const SESSION_PAGE = 25;
  const sessions = await ctx.db
    .query("agentSessions")
    .withIndex("by_lastActivityAt", (q) => q.lt("lastActivityAt", cutoff))
    .take(SESSION_PAGE);
  for (const session of sessions) {
    const result = await deleteSessionCascade(ctx, session._id, left);
    left -= result.used;
    if (!result.done || left <= 0) return { used: budget - left, more: true };
  }
  if (sessions.length === SESSION_PAGE) return { used: budget - left, more: true };

  const stale = await ctx.db
    .query("agentPendingActions")
    .withIndex("by_updatedAt", (q) => q.lt("updatedAt", cutoff))
    .take(left);
  for (const action of stale) await ctx.db.delete(action._id);
  left -= stale.length;
  return { used: budget - left, more: left <= 0 };
}
