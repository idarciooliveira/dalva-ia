/**
 * The chat agent's store: sessions, messages, pending actions and history.
 * Ephemeral (see `src/jobs/retention.ts`). Callable only with a token for a
 * linked chat (`agent:state`); each procedure works on that chat's identity.
 */
import { AGENT_ACTION_JSON_MAX_BYTES, AGENT_APPEND_MAX_MESSAGES, AGENT_MESSAGE_CONTENT_MAX_BYTES } from "@mpf/shared";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import type { UserPrincipal } from "../http/principal";
import { agentActionStatus, agentMessageRole, channelIdentities } from "../db/schema";
import type { Tx } from "../db/tx";
import * as agentStore from "../domain/agentStore";
import type { ChannelIdentity } from "../domain/channelLinks";
import { DomainError } from "../domain/errors";
import { accountAdjustInput } from "./accounts";
import { channelSchema } from "./chatLinks";
import { debtPaymentRecordInput, debtPaymentRemoveInput } from "./debts";
import { iso } from "./dto";
import { validationIssues } from "./errors";
import { goalContributionAddInput, goalContributionRemoveInput } from "./goals";
import { agentRead, agentWrite, commitThenFail, router } from "./init";
import { externalIdSchema, jsonString, boundedJson } from "./json";
import { noInput } from "./schemas";
import { transactionCreateInput, transactionDeleteInput, transactionUpdateInput } from "./transactions";
import { transferCreateInput, transferDeleteInput, transferUpdateInput } from "./transfers";

/**
 * Writes a pending action can carry: the finance writes the agent may
 * propose, by procedure path. Account management and the profile are web only.
 */
export const ACTION_INPUTS = {
  "accounts.adjust": accountAdjustInput,
  "transactions.create": transactionCreateInput,
  "transactions.update": transactionUpdateInput,
  "transactions.delete": transactionDeleteInput,
  "transfers.create": transferCreateInput,
  "transfers.update": transferUpdateInput,
  "transfers.delete": transferDeleteInput,
  "goalContributions.add": goalContributionAddInput,
  "goalContributions.remove": goalContributionRemoveInput,
  "debtPayments.record": debtPaymentRecordInput,
  "debtPayments.remove": debtPaymentRemoveInput,
} satisfies Record<string, z.ZodType>;

export const agentActionOperationSchema = z.enum(Object.keys(ACTION_INPUTS) as [keyof typeof ACTION_INPUTS, ...Array<keyof typeof ACTION_INPUTS>]);
export const agentActionStatusSchema = z.enum(agentActionStatus.enumValues);
export const agentMessageRoleSchema = z.enum(agentMessageRole.enumValues);

export const agentSessionSchema = z.object({
  id: z.string(),
  channel: channelSchema,
  chatId: z.string(),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  endedAt: z.string().optional(),
  messageCount: z.number().int(),
});

export const agentMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: agentMessageRoleSchema,
  /** Provider-agnostic JSON, stored as is. */
  content: z.string(),
  /** 1-based position in the session. */
  seq: z.number().int(),
  createdAt: z.string(),
});

export const agentPendingActionSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  clientKey: z.string().optional(),
  operation: agentActionOperationSchema,
  /** Input of the operation, as its procedure takes it. */
  input: z.record(z.string(), z.json()),
  /** Human text for the Confirm/Cancel message. */
  summary: z.string(),
  status: agentActionStatusSchema,
  expiresAt: z.string(),
  result: z.json().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const actionResult = z.object({ action: agentPendingActionSchema });

/** Session and action ids: any URL-safe string; one that names nothing of the caller's is `not_found`. */
const storeId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "Invalid id");
const historyDeleted = z.object({ deleted: z.literal(true) });

async function callerIdentity(tx: Tx, user: UserPrincipal): Promise<ChannelIdentity> {
  const [identity] = user.channelIdentityId
    ? await tx
        .select()
        .from(channelIdentities)
        .where(and(eq(channelIdentities.id, user.channelIdentityId), eq(channelIdentities.userId, user.userId), isNull(channelIdentities.unlinkedAt)))
        .limit(1)
    : [];
  if (!identity) throw new DomainError("unauthorized", "Channel link revoked");
  return identity;
}

function requireWriteAccess(identity: ChannelIdentity) {
  if (!identity.scopes.includes("finance:write")) throw new DomainError("forbidden", "Channel link lacks the finance:write scope");
}

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
  operation: action.operation as z.output<typeof agentActionOperationSchema>,
  input: JSON.parse(action.input) as Record<string, never>,
  summary: action.summary,
  status: action.status,
  expiresAt: iso(action.expiresAt),
  ...(action.result === null ? {} : { result: JSON.parse(action.result) as null }),
  createdAt: iso(action.createdAt),
  updatedAt: iso(action.updatedAt),
});

/** A refused transition still commits (an expired action is marked `expired`), then answers `conflict`. */
function transitionResult(transition: agentStore.ActionTransition) {
  if (transition.ok) return { action: actionDto(transition.action) };
  throw commitThenFail(
    new DomainError("conflict", transition.reason === "expired" ? "Pending action expired" : `Pending action is ${transition.status}`, {
      status: transition.status,
    }),
  );
}

export const agentSessionsRouter = router({
  /**
   * The chat's active session. Idle longer than `idleTimeoutMinutes` ends it
   * and starts a new one (`created: true`); so does `startNew` (after `append`
   * answered `conflict` because the session is full). `channel` and `chatId`
   * must be the chat the token was resolved for.
   */
  current: agentWrite
    .input(
      z.strictObject({
        channel: channelSchema,
        chatId: externalIdSchema,
        idleTimeoutMinutes: z.number().int().min(1).max(10_080),
        startNew: z.boolean().optional(),
      }),
    )
    .output(z.object({ session: agentSessionSchema, created: z.boolean() }))
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const identity = await callerIdentity(tx, user);
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
});

export const agentMessagesRouter = router({
  /** The latest `limit` messages of a session, oldest first. */
  list: agentRead
    .input(z.strictObject({ sessionId: storeId, limit: z.number().int().min(1).max(200).default(50) }))
    .output(z.object({ items: z.array(agentMessageSchema) }))
    .query(async ({ ctx: { tx, user }, input }) => {
      const identity = await callerIdentity(tx, user);
      const session = await agentStore.loadSession(tx, user.userId, identity.id, input.sessionId);
      return { items: (await agentStore.listMessages(tx, session.id, input.limit)).map(messageDto) };
    }),

  /** In order, bumping `lastActivityAt`. `conflict` when the session ended or would pass its message cap (nothing stored). */
  append: agentWrite
    .input(
      z.strictObject({
        sessionId: storeId,
        messages: z
          .array(z.strictObject({ role: agentMessageRoleSchema, content: jsonString(AGENT_MESSAGE_CONTENT_MAX_BYTES) }))
          .min(1)
          .max(AGENT_APPEND_MAX_MESSAGES),
      }),
    )
    .output(z.object({ items: z.array(agentMessageSchema) }))
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const identity = await callerIdentity(tx, user);
      const session = await agentStore.loadSession(tx, user.userId, identity.id, input.sessionId);
      const stored = await agentStore.appendMessages(tx, session, input.messages, new Date());
      return { items: stored.map(messageDto) };
    }),
});

export const agentPendingActionsRouter = router({
  /**
   * `input` is checked against the operation's own input schema, so a button
   * never leads to an action that can't run. `ttlSeconds` defaults to 10
   * minutes. A second create with the same `clientKey` by the same user (any
   * session) returns the existing action, whatever its status, and stores nothing.
   */
  create: agentWrite
    .input(
      z.strictObject({
        sessionId: storeId,
        operation: agentActionOperationSchema,
        input: boundedJson(z.record(z.string(), z.json()), AGENT_ACTION_JSON_MAX_BYTES),
        summary: z.string().trim().min(1).max(500),
        ttlSeconds: z.number().int().min(30).max(3600).optional(),
        /** Caller's dedupe key, unique per user (e.g. inbound event id + proposal index). */
        clientKey: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/).optional(),
      }),
    )
    .output(actionResult)
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const identity = await callerIdentity(tx, user);
      requireWriteAccess(identity);
      const session = await agentStore.loadSession(tx, user.userId, identity.id, input.sessionId);
      const parsed = ACTION_INPUTS[input.operation].safeParse(input.input);
      if (!parsed.success) {
        throw new DomainError("validation_failed", "Action input does not match the operation", validationIssues(parsed.error.issues));
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

  get: agentRead
    .input(z.strictObject({ id: storeId }))
    .output(actionResult)
    .query(async ({ ctx: { tx, user }, input }) => {
      const identity = await callerIdentity(tx, user);
      return { action: actionDto(await agentStore.loadAction(tx, user.userId, identity.id, input.id)) };
    }),

  /**
   * Atomic `pending -> confirmed`, with the operation and input to run (use the
   * action id as its `Idempotency-Key`). `conflict` when not pending or expired
   * (an expired one is marked `expired`).
   */
  confirm: agentWrite
    .input(z.strictObject({ id: storeId }))
    .output(actionResult)
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const identity = await callerIdentity(tx, user);
      requireWriteAccess(identity);
      const action = await agentStore.loadAction(tx, user.userId, identity.id, input.id);
      return transitionResult(await agentStore.transitionPending(tx, action, "confirmed", new Date()));
    }),

  /** `pending -> cancelled`. `conflict` in any other state. */
  cancel: agentWrite
    .input(z.strictObject({ id: storeId }))
    .output(actionResult)
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const identity = await callerIdentity(tx, user);
      const action = await agentStore.loadAction(tx, user.userId, identity.id, input.id);
      return transitionResult(await agentStore.transitionPending(tx, action, "cancelled", new Date()));
    }),

  /** `confirmed -> executed | failed`, with what the operation returned (or its error). */
  complete: agentWrite
    .input(z.strictObject({ id: storeId, status: z.enum(["executed", "failed"]), result: boundedJson(z.json(), AGENT_ACTION_JSON_MAX_BYTES) }))
    .output(actionResult)
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const identity = await callerIdentity(tx, user);
      const action = await agentStore.loadAction(tx, user.userId, identity.id, input.id);
      const done = await agentStore.completeAction(tx, action, input.status, JSON.stringify(input.result), new Date());
      return { action: actionDto(done) };
    }),
});

export const agentHistoryRouter = router({
  /** The user's sessions, messages and pending actions, for every channel. */
  delete: agentWrite
    .input(noInput)
    .output(historyDeleted)
    .mutation(async ({ ctx }) => {
      await agentStore.deleteUserHistory(ctx.tx, ctx.user.userId);
      return { deleted: true as const };
    }),
});
