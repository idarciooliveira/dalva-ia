import { routes, validationIssues, type AgentActionOperation, type RouteDef } from "@mpf/finance-contract";

import type { Doc } from "../../_generated/dataModel";
import * as agentStore from "../../domain/agentStore";
import { agentMutation, agentQuery } from "./define";
import { apiError, handlerFailure } from "./errors";

/*
 * Agent store routes (user token with `agent:state`). `userId` and the chat
 * identity come from the token (see `define.ts`), never from the request.
 */

/**
 * A button that can only fail is worse than none: creating or confirming a
 * write needs an identity that still has `finance:write` (the user may have
 * switched to read-only after the token was minted). Cancelling stays allowed.
 */
function requireWriteAccess(identity: Doc<"channelIdentities">) {
  if (!identity.scopes.includes("finance:write")) throw apiError("forbidden", "Channel link lacks the finance:write scope");
}

const iso = (ms: number) => new Date(ms).toISOString();

const sessionDto = (session: Doc<"agentSessions">) => ({
  id: session._id as string,
  channel: session.channel,
  chatId: session.chatId,
  startedAt: iso(session.startedAt),
  lastActivityAt: iso(session.lastActivityAt),
  ...(session.endedAt === undefined ? {} : { endedAt: iso(session.endedAt) }),
  messageCount: session.messageCount,
});

const messageDto = (message: Doc<"agentMessages">) => ({
  id: message._id as string,
  sessionId: message.sessionId as string,
  role: message.role,
  content: message.content,
  seq: message.seq,
  createdAt: iso(message.createdAt),
});

const actionDto = (action: Doc<"agentPendingActions">) => ({
  id: action._id as string,
  sessionId: action.sessionId as string,
  operation: action.operation as AgentActionOperation,
  input: JSON.parse(action.input) as Record<string, never>,
  summary: action.summary,
  status: action.status,
  expiresAt: iso(action.expiresAt),
  ...(action.result === undefined ? {} : { result: JSON.parse(action.result) as null }),
  createdAt: iso(action.createdAt),
  updatedAt: iso(action.updatedAt),
});

/* -------------------------------------------------------------------------- */
/*  Sessions and messages                                                     */
/* -------------------------------------------------------------------------- */

export const currentSession = agentMutation(routes.agentSessions.current, async (ctx, { userId, identity }, input) => {
  // The token was resolved for one chat; a different chat id is an agent bug, not a new session.
  if (input.channel !== identity.channel || input.chatId !== identity.chatId) throw new Error(agentStore.CHAT_MISMATCH);
  const { session, created } = await agentStore.currentSession(ctx, {
    userId,
    identity,
    chatId: input.chatId,
    idleMs: input.idleTimeoutMinutes * 60_000,
    startNew: input.startNew === true,
    now: Date.now(),
  });
  return { session: sessionDto(session), created };
});

export const listMessages = agentQuery(routes.agentMessages.list, async (ctx, { userId, identity }, input) => {
  const session = await agentStore.loadSession(ctx, userId, identity._id, input.sessionId);
  return { items: (await agentStore.listMessages(ctx, session._id, input.limit)).map(messageDto) };
});

export const appendMessages = agentMutation(routes.agentMessages.append, async (ctx, { userId, identity }, input) => {
  const session = await agentStore.loadSession(ctx, userId, identity._id, input.sessionId);
  const stored = await agentStore.appendMessages(ctx, session, input.messages, Date.now());
  return { items: stored.map(messageDto) };
});

/* -------------------------------------------------------------------------- */
/*  Pending actions                                                           */
/* -------------------------------------------------------------------------- */

/** The contract's request schema for a `group.op` operation name, or null. */
function operationRoute(operation: string): RouteDef | null {
  const [group, op] = operation.split(".");
  return (routes as unknown as Record<string, Record<string, RouteDef> | undefined>)[group ?? ""]?.[op ?? ""] ?? null;
}

export const createPendingAction = agentMutation(routes.agentPendingActions.create, async (ctx, { userId, identity }, input) => {
  requireWriteAccess(identity);
  const session = await agentStore.loadSession(ctx, userId, identity._id, input.sessionId);
  // The button must lead to something that can run: check the input against the operation's own schema now.
  const route = operationRoute(input.operation);
  if (!route) throw apiError("validation_failed", "Unknown operation");
  const parsed = route.request.safeParse(input.input);
  if (!parsed.success) {
    throw apiError("validation_failed", "Action input does not match the operation", validationIssues(parsed.error));
  }
  const action = await agentStore.createPendingAction(ctx, session, {
    operation: input.operation,
    input: JSON.stringify(parsed.data),
    summary: input.summary,
    ttlMs: input.ttlSeconds === undefined ? agentStore.DEFAULT_ACTION_TTL_MS : input.ttlSeconds * 1000,
    now: Date.now(),
  });
  return { action: actionDto(action) };
});

export const getPendingAction = agentQuery(routes.agentPendingActions.get, async (ctx, { userId, identity }, input) => {
  return { action: actionDto(await agentStore.loadAction(ctx, userId, identity._id, input.id)) };
});

function transitionResult(transition: agentStore.ActionTransition) {
  if (transition.ok) return { action: actionDto(transition.action) };
  return handlerFailure(
    "conflict",
    transition.reason === "expired" ? "Pending action expired" : `Pending action is ${transition.status}`,
    { status: transition.status },
  );
}

export const confirmPendingAction = agentMutation(routes.agentPendingActions.confirm, async (ctx, { userId, identity }, input) => {
  requireWriteAccess(identity);
  const action = await agentStore.loadAction(ctx, userId, identity._id, input.id);
  return transitionResult(await agentStore.transitionPending(ctx, action, "confirmed", Date.now()));
});

export const cancelPendingAction = agentMutation(routes.agentPendingActions.cancel, async (ctx, { userId, identity }, input) => {
  const action = await agentStore.loadAction(ctx, userId, identity._id, input.id);
  return transitionResult(await agentStore.transitionPending(ctx, action, "cancelled", Date.now()));
});

export const completePendingAction = agentMutation(routes.agentPendingActions.complete, async (ctx, { userId, identity }, input) => {
  const action = await agentStore.loadAction(ctx, userId, identity._id, input.id);
  const done = await agentStore.completeAction(ctx, action, input.status, JSON.stringify(input.result), Date.now());
  return { action: actionDto(done) };
});

/* -------------------------------------------------------------------------- */
/*  History                                                                   */
/* -------------------------------------------------------------------------- */

export const deleteHistory = agentMutation(routes.agentHistory.delete, async (ctx, { userId }) => {
  await agentStore.deleteUserHistory(ctx, userId);
  return { deleted: true as const };
});
