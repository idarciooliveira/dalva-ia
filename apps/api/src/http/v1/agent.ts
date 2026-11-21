/**
 * Agent-store routes (user token with `agent:state`, minted for a linked chat).
 * Ported from `packages/backend/convex/api/v1/agent.ts`. The user and the chat
 * identity come from the token; the router has already checked that the
 * identity is still linked, in this same transaction.
 */
import { type AgentActionOperation, type RouteDef, routes, validationIssues } from "@mpf/finance-contract";
import { and, eq, isNull } from "drizzle-orm";

import { channelIdentities } from "../../db/schema";
import type { Tx } from "../../db/tx";
import * as agentStore from "../../domain/agentStore";
import type { ChannelIdentity } from "../../domain/channelLinks";
import { DomainError } from "../../domain/errors";
import { commitThenFail, operation } from "../operation";
import type { UserPrincipal } from "../principal";

/** The chat identity the token was resolved for. */
async function callerIdentity(tx: Tx, user: UserPrincipal): Promise<ChannelIdentity> {
  const [identity] = user.channelIdentityId
    ? await tx
        .select()
        .from(channelIdentities)
        .where(
          and(
            eq(channelIdentities.id, user.channelIdentityId),
            eq(channelIdentities.userId, user.userId),
            isNull(channelIdentities.unlinkedAt),
          ),
        )
        .limit(1)
    : [];
  // The router checked both already; kept so a handler can never run without its identity.
  if (!identity) throw new DomainError("unauthorized", "Channel link revoked");
  return identity;
}

/**
 * A button that can only fail is worse than none: creating or confirming a
 * write needs an identity that still has `finance:write` (the user may have
 * switched to read-only after the token was minted). Cancelling stays allowed.
 */
function requireWriteAccess(identity: ChannelIdentity) {
  if (!identity.scopes.includes("finance:write")) {
    throw new DomainError("forbidden", "Channel link lacks the finance:write scope");
  }
}

/* DTOs --------------------------------------------------------------------- */

const iso = (date: Date) => date.toISOString();

const sessionDto = (session: agentStore.AgentSession) => ({
  id: session.id,
  channel: session.channel,
  chatId: session.chatId,
  startedAt: iso(session.startedAt),
  lastActivityAt: iso(session.lastActivityAt),
  ...(session.endedAt === null ? {} : { endedAt: iso(session.endedAt) }),
  messageCount: session.messageCount,
});

const messageDto = (message: agentStore.AgentMessage) => ({
  id: message.id,
  sessionId: message.sessionId,
  role: message.role,
  content: message.content,
  seq: message.seq,
  createdAt: iso(message.createdAt),
});

const actionDto = (action: agentStore.AgentAction) => ({
  id: action.id,
  sessionId: action.sessionId,
  ...(action.clientKey === null ? {} : { clientKey: action.clientKey }),
  operation: action.operation as AgentActionOperation,
  input: JSON.parse(action.input) as Record<string, never>,
  summary: action.summary,
  status: action.status,
  expiresAt: iso(action.expiresAt),
  ...(action.result === null ? {} : { result: JSON.parse(action.result) as null }),
  createdAt: iso(action.createdAt),
  updatedAt: iso(action.updatedAt),
});

/* Sessions and messages ---------------------------------------------------- */

export const agentSessionOperations = {
  current: operation(routes.agentSessions.current, async (tx, user, input) => {
    const identity = await callerIdentity(tx, user);
    // The token was resolved for one chat; a different chat id is an agent bug, not a new session.
    if (input.channel !== identity.channel || input.chatId !== identity.chatId) {
      throw new DomainError("validation_failed", agentStore.CHAT_MISMATCH);
    }
    const { session, created } = await agentStore.currentSession(tx, {
      userId: user.userId,
      identity,
      chatId: input.chatId,
      idleMs: input.idleTimeoutMinutes * 60_000,
      startNew: input.startNew === true,
      now: new Date(),
    });
    return { session: sessionDto(session), created };
  }),
};

export const agentMessageOperations = {
  list: operation(routes.agentMessages.list, async (tx, user, input) => {
    const identity = await callerIdentity(tx, user);
    const session = await agentStore.loadSession(tx, user.userId, identity.id, input.sessionId);
    return { items: (await agentStore.listMessages(tx, session.id, input.limit)).map(messageDto) };
  }),

  append: operation(routes.agentMessages.append, async (tx, user, input) => {
    const identity = await callerIdentity(tx, user);
    const session = await agentStore.loadSession(tx, user.userId, identity.id, input.sessionId);
    const stored = await agentStore.appendMessages(tx, session, input.messages, new Date());
    return { items: stored.map(messageDto) };
  }),
};

/* Pending actions ---------------------------------------------------------- */

/** The contract route of a `group.op` operation name, or null. */
function operationRoute(name: string): RouteDef | null {
  const [group, op] = name.split(".");
  return (routes as unknown as Record<string, Record<string, RouteDef> | undefined>)[group ?? ""]?.[op ?? ""] ?? null;
}

function transitionResult(transition: agentStore.ActionTransition) {
  if (transition.ok) return { action: actionDto(transition.action) };
  // Commit the `expired` mark, then answer conflict (Convex `handlerFailure`).
  return commitThenFail(
    new DomainError(
      "conflict",
      transition.reason === "expired" ? "Pending action expired" : `Pending action is ${transition.status}`,
      { status: transition.status },
    ),
  );
}

export const agentPendingActionOperations = {
  create: operation(routes.agentPendingActions.create, async (tx, user, input) => {
    const identity = await callerIdentity(tx, user);
    requireWriteAccess(identity);
    const session = await agentStore.loadSession(tx, user.userId, identity.id, input.sessionId);
    // The button must lead to something that can run: check the input against the operation's own schema now.
    const route = operationRoute(input.operation);
    if (!route) throw new DomainError("validation_failed", "Unknown operation");
    const parsed = route.request.safeParse(input.input);
    if (!parsed.success) {
      throw new DomainError("validation_failed", "Action input does not match the operation", validationIssues(parsed.error));
    }
    const action = await agentStore.createPendingAction(tx, session, {
      operation: input.operation,
      input: JSON.stringify(parsed.data),
      summary: input.summary,
      ttlMs: input.ttlSeconds === undefined ? agentStore.DEFAULT_ACTION_TTL_MS : input.ttlSeconds * 1000,
      now: new Date(),
      ...(input.clientKey === undefined ? {} : { clientKey: input.clientKey }),
    });
    return { action: actionDto(action) };
  }),

  get: operation(routes.agentPendingActions.get, async (tx, user, input) => {
    const identity = await callerIdentity(tx, user);
    return { action: actionDto(await agentStore.loadAction(tx, user.userId, identity.id, input.id)) };
  }),

  confirm: operation(routes.agentPendingActions.confirm, async (tx, user, input) => {
    const identity = await callerIdentity(tx, user);
    requireWriteAccess(identity);
    const action = await agentStore.loadAction(tx, user.userId, identity.id, input.id);
    return transitionResult(await agentStore.transitionPending(tx, action, "confirmed", new Date()));
  }),

  cancel: operation(routes.agentPendingActions.cancel, async (tx, user, input) => {
    const identity = await callerIdentity(tx, user);
    const action = await agentStore.loadAction(tx, user.userId, identity.id, input.id);
    return transitionResult(await agentStore.transitionPending(tx, action, "cancelled", new Date()));
  }),

  complete: operation(routes.agentPendingActions.complete, async (tx, user, input) => {
    const identity = await callerIdentity(tx, user);
    const action = await agentStore.loadAction(tx, user.userId, identity.id, input.id);
    const done = await agentStore.completeAction(tx, action, input.status, JSON.stringify(input.result), new Date());
    return { action: actionDto(done) };
  }),
};

/* History ------------------------------------------------------------------ */

export const agentHistoryOperations = {
  delete: operation(routes.agentHistory.delete, async (tx, user) => {
    await agentStore.deleteUserHistory(tx, user.userId);
    return { deleted: true as const };
  }),
};
