/**
 * State for the chat agent: inbound events, sessions, messages and pending
 * actions. Ported from `packages/backend/convex/domain/agentStore.ts`. Every
 * function takes the already-authenticated user and chat identity from the
 * route; no id that came from a client is trusted without an ownership check.
 *
 * Differences from Convex: deleting history is one statement in the caller's
 * transaction (sessions cascade to their messages and actions), not batches
 * through the scheduler; the retention jobs (`src/jobs`) batch instead.
 */
import { AGENT_SESSION_MAX_MESSAGES } from "@mpf/finance-contract";
import { and, asc, count, desc, eq, inArray, isNull, lt, lte } from "drizzle-orm";

import type { Database } from "../db/client";
import { isUuid } from "../db/ids";
import { agentInboundEvents, agentMessages, agentPendingActions, agentSessions } from "../db/schema";
import type { Tx } from "../db/tx";
import type { ChannelIdentity } from "./channelLinks";
import { conflict, DomainError } from "./errors";

export type AgentEvent = typeof agentInboundEvents.$inferSelect;
export type AgentSession = typeof agentSessions.$inferSelect;
export type AgentMessage = typeof agentMessages.$inferSelect;
export type AgentAction = typeof agentPendingActions.$inferSelect;
type Channel = AgentEvent["channel"];
type ActionStatus = AgentAction["status"];

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** Inbound events (they hold message text) are deleted this long after their last update. */
export const EVENT_RETENTION_MS = DAY_MS;
/** Sessions without activity, and finished actions, are deleted after this long. */
export const SESSION_RETENTION_MS = 30 * DAY_MS;
export const DEFAULT_ACTION_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_PER_SESSION = 20;
export const MAX_SESSION_MESSAGES = AGENT_SESSION_MAX_MESSAGES;

/* Same messages as Convex. */
export const EVENT_NOT_FOUND = "Event not found";
export const EVENT_FINISHED = "Event is already finished";
export const SESSION_NOT_FOUND = "Session not found";
export const SESSION_ENDED = "Session has ended";
export const SESSION_FULL = "Session has reached its message limit";
export const CHAT_MISMATCH = "Chat does not match the linked chat";
export const ACTION_NOT_FOUND = "Pending action not found";
export const TOO_MANY_PENDING = "Too many pending actions in this session";
export const ACTION_NOT_CONFIRMED = "Pending action is not confirmed";

/* -------------------------------------------------------------------------- */
/*  Inbound events                                                            */
/* -------------------------------------------------------------------------- */

const eventKey = (channel: Channel, eventId: string) =>
  and(eq(agentInboundEvents.channel, channel), eq(agentInboundEvents.eventId, eventId));

/**
 * First claim of an event wins (`new`); later ones are `duplicate` and change
 * nothing. Two concurrent claims serialize on the unique key: the second
 * reruns and sees the first.
 */
export async function claimEvent(
  tx: Tx,
  args: { channel: Channel; eventId: string; payload: string; now: Date },
): Promise<"new" | "duplicate"> {
  const inserted = await tx
    .insert(agentInboundEvents)
    .values({
      channel: args.channel,
      eventId: args.eventId,
      status: "received",
      attempts: 0,
      payload: args.payload,
      receivedAt: args.now,
      updatedAt: args.now,
    })
    .onConflictDoNothing({ target: [agentInboundEvents.channel, agentInboundEvents.eventId] })
    .returning({ id: agentInboundEvents.id });
  return inserted.length > 0 ? "new" : "duplicate";
}

/**
 * `processing` counts an attempt. `done` and `failed` are final and drop the
 * payload: it is message text, and nothing re-processes a finished event.
 */
export async function updateEventStatus(
  tx: Tx,
  args: { channel: Channel; eventId: string; status: "processing" | "done" | "failed"; error?: string; now: Date },
): Promise<AgentEvent> {
  const [event] = await tx.select().from(agentInboundEvents).where(eventKey(args.channel, args.eventId)).limit(1);
  if (!event) throw notFoundMessage(EVENT_NOT_FOUND);
  if (event.status === "done" || event.status === "failed") throw conflict(EVENT_FINISHED);

  const [updated] = await tx
    .update(agentInboundEvents)
    .set({
      status: args.status,
      updatedAt: args.now,
      ...(args.status === "processing" ? { attempts: event.attempts + 1 } : { payload: "" }),
      // NUL can't go in a Postgres `text`; dropping it keeps the final status and the payload clear from rolling back.
      ...(args.status === "failed" && args.error ? { error: args.error.replaceAll("\u0000", "") } : {}),
    })
    .where(eq(agentInboundEvents.id, event.id))
    .returning();
  return updated!;
}

/** Events stuck in `received` or `processing` since before `now - olderThanMs` with attempts left, oldest first. */
export async function listRecoverableEvents(
  tx: Tx,
  args: { channel: Channel; olderThanMs: number; maxAttempts: number; limit: number; now: Date },
): Promise<AgentEvent[]> {
  return await tx
    .select()
    .from(agentInboundEvents)
    .where(
      and(
        eq(agentInboundEvents.channel, args.channel),
        inArray(agentInboundEvents.status, ["received", "processing"]),
        lt(agentInboundEvents.updatedAt, new Date(args.now.getTime() - args.olderThanMs)),
        lt(agentInboundEvents.attempts, args.maxAttempts),
      ),
    )
    .orderBy(asc(agentInboundEvents.updatedAt), asc(agentInboundEvents.id))
    .limit(args.limit);
}

/* -------------------------------------------------------------------------- */
/*  Sessions and messages                                                     */
/* -------------------------------------------------------------------------- */

/** A session of this user and identity, or `SESSION_NOT_FOUND` (never says whether it exists for someone else). */
export async function loadSession(tx: Tx, userId: string, identityId: string, rawId: string): Promise<AgentSession> {
  // Any other id (another table's, or not an id at all) is simply not a session: not_found, as Convex.
  if (!isUuid(rawId)) throw notFoundMessage(SESSION_NOT_FOUND);
  const [session] = await tx
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, rawId), eq(agentSessions.userId, userId), eq(agentSessions.identityId, identityId)))
    .limit(1);
  if (!session) throw notFoundMessage(SESSION_NOT_FOUND);
  return session;
}

/**
 * The chat's active session. A session idle for longer than `idleMs` (or
 * `startNew`, or one left over from an earlier link) is ended and replaced.
 */
export async function currentSession(
  tx: Tx,
  args: { userId: string; identity: ChannelIdentity; chatId: string; idleMs: number; startNew: boolean; now: Date },
): Promise<{ session: AgentSession; created: boolean }> {
  const { userId, identity, now } = args;
  const open = await tx
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.userId, userId),
        eq(agentSessions.channel, identity.channel),
        eq(agentSessions.chatId, args.chatId),
        isNull(agentSessions.endedAt),
      ),
    )
    .orderBy(desc(agentSessions.createdAt), desc(agentSessions.id))
    .limit(5);

  const [latest, ...extra] = open;
  // Writes serialize, so there is normally one. Close any stray rather than fail.
  if (extra.length > 0) await endSessions(tx, extra.map((s) => s.id), now);

  if (latest) {
    const reusable =
      !args.startNew && latest.identityId === identity.id && now.getTime() - latest.lastActivityAt.getTime() <= args.idleMs;
    if (reusable) return { session: latest, created: false };
    await endSessions(tx, [latest.id], now);
  }

  const [session] = await tx
    .insert(agentSessions)
    .values({
      userId,
      identityId: identity.id,
      channel: identity.channel,
      chatId: args.chatId,
      startedAt: now,
      lastActivityAt: now,
      messageCount: 0,
      createdAt: now,
    })
    .returning();
  return { session: session!, created: true };
}

async function endSessions(tx: Tx, ids: string[], now: Date): Promise<void> {
  await tx.update(agentSessions).set({ endedAt: now }).where(inArray(agentSessions.id, ids));
}

/** The latest `limit` messages, oldest first. */
export async function listMessages(tx: Tx, sessionId: string, limit: number): Promise<AgentMessage[]> {
  const latest = await tx
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.sessionId, sessionId))
    .orderBy(desc(agentMessages.seq))
    .limit(limit);
  return latest.reverse();
}

/** Store a batch in order. All or nothing: an ended or full session stores none of it. */
export async function appendMessages(
  tx: Tx,
  session: AgentSession,
  messages: Array<{ role: AgentMessage["role"]; content: string }>,
  now: Date,
): Promise<AgentMessage[]> {
  if (session.endedAt !== null) throw conflict(SESSION_ENDED);
  if (session.messageCount + messages.length > MAX_SESSION_MESSAGES) throw conflict(SESSION_FULL);

  // Session row first: a concurrent append to the same session then waits on it and reruns
  // (serialization failure) instead of colliding on `(session_id, seq)` (a unique violation).
  await tx
    .update(agentSessions)
    .set({ messageCount: session.messageCount + messages.length, lastActivityAt: now })
    .where(eq(agentSessions.id, session.id));
  const stored = await tx
    .insert(agentMessages)
    .values(
      messages.map((message, i) => ({
        sessionId: session.id,
        userId: session.userId,
        role: message.role,
        content: message.content,
        seq: session.messageCount + i + 1,
        createdAt: now,
      })),
    )
    .returning();
  return stored.sort((a, b) => a.seq - b.seq);
}

/* -------------------------------------------------------------------------- */
/*  Pending actions                                                           */
/* -------------------------------------------------------------------------- */

/** An action of this user, in a session of this identity, or `ACTION_NOT_FOUND`. */
export async function loadAction(tx: Tx, userId: string, identityId: string, rawId: string): Promise<AgentAction> {
  if (!isUuid(rawId)) throw notFoundMessage(ACTION_NOT_FOUND);
  const [row] = await tx
    .select({ action: agentPendingActions })
    .from(agentPendingActions)
    .innerJoin(agentSessions, eq(agentSessions.id, agentPendingActions.sessionId))
    .where(
      and(eq(agentPendingActions.id, rawId), eq(agentPendingActions.userId, userId), eq(agentSessions.identityId, identityId)),
    )
    .limit(1);
  if (!row) throw notFoundMessage(ACTION_NOT_FOUND);
  return row.action;
}

/**
 * At most `MAX_PENDING_PER_SESSION` live pending actions per session. Rows
 * past `expiresAt` that the job has not reached yet are expired here first,
 * so they neither count against the limit nor linger as `pending`.
 */
async function assertRoomForAction(tx: Tx, sessionId: string, now: Date): Promise<void> {
  const pendingInSession = and(eq(agentPendingActions.sessionId, sessionId), eq(agentPendingActions.status, "pending"));
  await tx
    .update(agentPendingActions)
    .set({ status: "expired", updatedAt: now })
    .where(and(pendingInSession, lte(agentPendingActions.expiresAt, now)));
  const [live] = await tx.select({ n: count() }).from(agentPendingActions).where(pendingInSession);
  if ((live?.n ?? 0) >= MAX_PENDING_PER_SESSION) throw conflict(TOO_MANY_PENDING);
}

export async function createPendingAction(
  tx: Tx,
  session: AgentSession,
  args: { operation: string; input: string; summary: string; ttlMs: number; now: Date; clientKey?: string },
): Promise<AgentAction> {
  // A repeated create (the caller replayed the same proposal) returns what the first one stored, in any
  // status. Per user and chat identity, not per session: a replay can land in a newer session of the same chat.
  if (args.clientKey !== undefined) {
    const [existing] = await tx
      .select({ action: agentPendingActions })
      .from(agentPendingActions)
      .innerJoin(agentSessions, eq(agentSessions.id, agentPendingActions.sessionId))
      .where(
        and(
          eq(agentPendingActions.userId, session.userId),
          eq(agentPendingActions.clientKey, args.clientKey),
          eq(agentSessions.identityId, session.identityId),
        ),
      )
      .orderBy(asc(agentPendingActions.createdAt), asc(agentPendingActions.id))
      .limit(1);
    if (existing) return existing.action;
  }
  if (session.endedAt !== null) throw conflict(SESSION_ENDED);
  await assertRoomForAction(tx, session.id, args.now);
  const [action] = await tx
    .insert(agentPendingActions)
    .values({
      userId: session.userId,
      sessionId: session.id,
      clientKey: args.clientKey ?? null,
      operation: args.operation,
      input: args.input,
      summary: args.summary,
      status: "pending",
      expiresAt: new Date(args.now.getTime() + args.ttlMs),
      createdAt: args.now,
      updatedAt: args.now,
    })
    .returning();
  return action!;
}

export type ActionTransition =
  | { ok: true; action: AgentAction }
  | { ok: false; reason: "expired" | "not_pending"; status: ActionStatus };

/**
 * `pending -> next`, atomically (one SERIALIZABLE transaction, so of two
 * racing calls only one sees `pending`). An expired action is marked
 * `expired` and reported as a failure value rather than thrown, so the
 * caller can commit the mark and still answer with an error.
 */
export async function transitionPending(
  tx: Tx,
  action: AgentAction,
  next: "confirmed" | "cancelled",
  now: Date,
): Promise<ActionTransition> {
  if (action.status !== "pending") return { ok: false, reason: "not_pending", status: action.status };
  if (action.expiresAt <= now) {
    await tx.update(agentPendingActions).set({ status: "expired", updatedAt: now }).where(eq(agentPendingActions.id, action.id));
    return { ok: false, reason: "expired", status: "expired" };
  }
  const [updated] = await tx
    .update(agentPendingActions)
    .set({ status: next, updatedAt: now })
    .where(eq(agentPendingActions.id, action.id))
    .returning();
  return { ok: true, action: updated! };
}

/** `confirmed -> executed | failed`. */
export async function completeAction(
  tx: Tx,
  action: AgentAction,
  status: "executed" | "failed",
  result: string,
  now: Date,
): Promise<AgentAction> {
  if (action.status !== "confirmed") throw conflict(ACTION_NOT_CONFIRMED);
  const [updated] = await tx
    .update(agentPendingActions)
    .set({ status, result, updatedAt: now })
    .where(eq(agentPendingActions.id, action.id))
    .returning();
  return updated!;
}

/* -------------------------------------------------------------------------- */
/*  Deleting history                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Delete a user's chat history on every channel: sessions, and with them
 * (cascade) their messages and pending actions. One statement in the caller's
 * transaction, so only history that exists when it runs goes, and a session
 * the agent writes to concurrently makes one of the two transactions rerun.
 */
export async function deleteUserHistory(tx: Tx, userId: string): Promise<void> {
  await tx.delete(agentSessions).where(eq(agentSessions.userId, userId));
}

/** Delete one identity's history, e.g. when it is unlinked. */
export async function deleteIdentityHistory(tx: Tx, userId: string, identityId: string): Promise<void> {
  await tx.delete(agentSessions).where(and(eq(agentSessions.userId, userId), eq(agentSessions.identityId, identityId)));
}

/* -------------------------------------------------------------------------- */
/*  Retention (src/jobs): one batch per call, single statements on the pool   */
/* -------------------------------------------------------------------------- */
/*
 * READ COMMITTED, outside any request transaction. Each statement repeats its
 * condition on the rows it changes: a row a request touched meanwhile (an
 * event moved to `processing`, a message appended) is re-checked after the
 * request commits and left alone. A request that loses to the job reruns
 * (serialization failure) and sees the row gone.
 */

/** Delete events untouched since `cutoff`, whatever their status. Returns how many. */
export async function purgeStaleEvents(db: Database, cutoff: Date, batch: number): Promise<number> {
  const stale = db.select({ id: agentInboundEvents.id }).from(agentInboundEvents).where(lt(agentInboundEvents.updatedAt, cutoff)).limit(batch);
  const deleted = await db
    .delete(agentInboundEvents)
    .where(and(inArray(agentInboundEvents.id, stale), lt(agentInboundEvents.updatedAt, cutoff)))
    .returning({ id: agentInboundEvents.id });
  return deleted.length;
}

/** Mark pending actions past `expiresAt` as expired. Returns how many. */
export async function expirePendingActions(db: Database, now: Date, batch: number): Promise<number> {
  const due = db
    .select({ id: agentPendingActions.id })
    .from(agentPendingActions)
    .where(and(eq(agentPendingActions.status, "pending"), lt(agentPendingActions.expiresAt, now)))
    .limit(batch);
  // Re-checked on the row itself: an action confirmed meanwhile is left alone.
  const expired = await db
    .update(agentPendingActions)
    .set({ status: "expired", updatedAt: now })
    .where(and(inArray(agentPendingActions.id, due), eq(agentPendingActions.status, "pending")))
    .returning({ id: agentPendingActions.id });
  return expired.length;
}

/** Delete sessions with no activity for `SESSION_RETENTION_MS`, with their messages and actions. Returns sessions deleted. */
export async function purgeInactiveSessions(db: Database, now: Date, batch: number): Promise<number> {
  const cutoff = new Date(now.getTime() - SESSION_RETENTION_MS);
  const inactive = db.select({ id: agentSessions.id }).from(agentSessions).where(lt(agentSessions.lastActivityAt, cutoff)).limit(batch);
  const deleted = await db
    .delete(agentSessions)
    .where(and(inArray(agentSessions.id, inactive), lt(agentSessions.lastActivityAt, cutoff)))
    .returning({ id: agentSessions.id });
  return deleted.length;
}

/** Delete actions (any status, any session) not updated for `SESSION_RETENTION_MS`. Returns how many. */
export async function purgeStaleActions(db: Database, now: Date, batch: number): Promise<number> {
  const cutoff = new Date(now.getTime() - SESSION_RETENTION_MS);
  const stale = db.select({ id: agentPendingActions.id }).from(agentPendingActions).where(lt(agentPendingActions.updatedAt, cutoff)).limit(batch);
  const deleted = await db
    .delete(agentPendingActions)
    .where(and(inArray(agentPendingActions.id, stale), lt(agentPendingActions.updatedAt, cutoff)))
    .returning({ id: agentPendingActions.id });
  return deleted.length;
}

function notFoundMessage(message: string): DomainError {
  return new DomainError("not_found", message);
}
