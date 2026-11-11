import { describe, expect, it } from "vitest";

import {
  AGENT_MESSAGE_CONTENT_MAX_BYTES,
  agentEventClaimRequestSchema,
  agentEventsRecoverableRequestSchema,
  agentEventUpdateStatusRequestSchema,
  agentHistoryDeleteRequestSchema,
  agentMessagesAppendRequestSchema,
  agentMessagesListRequestSchema,
  agentPendingActionCompleteRequestSchema,
  agentPendingActionCreateRequestSchema,
  agentPendingActionSchema,
  agentSessionCurrentRequestSchema,
  channelIdentityResolveResponseSchema,
} from "./schemas";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success;

describe("agent events", () => {
  it("claim needs a channel, a safe event id and a JSON payload under the cap", () => {
    const base = { channel: "telegram", eventId: "9001", payload: '{"update_id":9001}' };
    expect(ok(agentEventClaimRequestSchema, base)).toBe(true);
    expect(ok(agentEventClaimRequestSchema, { ...base, payload: "not json" })).toBe(false);
    expect(ok(agentEventClaimRequestSchema, { ...base, payload: JSON.stringify("x".repeat(33 * 1024)) })).toBe(false);
    expect(ok(agentEventClaimRequestSchema, { ...base, eventId: "a/b" })).toBe(false);
    expect(ok(agentEventClaimRequestSchema, { ...base, channel: "sms" })).toBe(false);
    expect(ok(agentEventClaimRequestSchema, { ...base, extra: 1 })).toBe(false);
  });

  it("counts payload size in UTF-8 bytes, not characters", () => {
    const payload = JSON.stringify("é".repeat(17 * 1024)); // 34 KiB of bytes, 17 K characters
    expect(ok(agentEventClaimRequestSchema, { channel: "telegram", eventId: "1", payload })).toBe(false);
  });

  it("update status only takes processing, done or failed", () => {
    const base = { channel: "telegram", eventId: "1" };
    for (const status of ["processing", "done", "failed"]) expect(ok(agentEventUpdateStatusRequestSchema, { ...base, status })).toBe(true);
    expect(ok(agentEventUpdateStatusRequestSchema, { ...base, status: "received" })).toBe(false);
    expect(ok(agentEventUpdateStatusRequestSchema, { ...base, status: "failed", error: "x".repeat(501) })).toBe(false);
  });

  it("list recoverable coerces query strings and has defaults", () => {
    expect(agentEventsRecoverableRequestSchema.parse({ channel: "telegram" })).toEqual({
      channel: "telegram",
      olderThanSeconds: 60,
      maxAttempts: 3,
      limit: 20,
    });
    expect(agentEventsRecoverableRequestSchema.parse({ channel: "telegram", olderThanSeconds: "30", limit: "5" })).toMatchObject({
      olderThanSeconds: 30,
      limit: 5,
    });
    expect(ok(agentEventsRecoverableRequestSchema, { channel: "telegram", limit: "500" })).toBe(false);
  });
});

describe("agent sessions and messages", () => {
  it("current needs a bounded idle timeout", () => {
    const base = { channel: "telegram", chatId: "42", idleTimeoutMinutes: 30 };
    expect(ok(agentSessionCurrentRequestSchema, base)).toBe(true);
    expect(ok(agentSessionCurrentRequestSchema, { ...base, startNew: true })).toBe(true);
    expect(ok(agentSessionCurrentRequestSchema, { ...base, idleTimeoutMinutes: 0 })).toBe(false);
    expect(ok(agentSessionCurrentRequestSchema, { ...base, idleTimeoutMinutes: 1.5 })).toBe(false);
    expect(ok(agentSessionCurrentRequestSchema, { ...base, idleTimeoutMinutes: 10_081 })).toBe(false);
  });

  it("list messages defaults and caps the limit", () => {
    expect(agentMessagesListRequestSchema.parse({ sessionId: "s1" }).limit).toBe(50);
    expect(agentMessagesListRequestSchema.parse({ sessionId: "s1", limit: "200" }).limit).toBe(200);
    expect(ok(agentMessagesListRequestSchema, { sessionId: "s1", limit: 201 })).toBe(false);
    expect(ok(agentMessagesListRequestSchema, { sessionId: "../x" })).toBe(false);
  });

  it("append takes 1-20 messages of JSON content under 32 KB", () => {
    const message = { role: "user", content: '{"text":"hi"}' };
    expect(ok(agentMessagesAppendRequestSchema, { sessionId: "s1", messages: [message] })).toBe(true);
    expect(ok(agentMessagesAppendRequestSchema, { sessionId: "s1", messages: [] })).toBe(false);
    expect(ok(agentMessagesAppendRequestSchema, { sessionId: "s1", messages: Array(21).fill(message) })).toBe(false);
    expect(ok(agentMessagesAppendRequestSchema, { sessionId: "s1", messages: [{ ...message, role: "bot" }] })).toBe(false);
    expect(ok(agentMessagesAppendRequestSchema, { sessionId: "s1", messages: [{ ...message, content: "{nope" }] })).toBe(false);
    const big = JSON.stringify("x".repeat(AGENT_MESSAGE_CONTENT_MAX_BYTES));
    expect(ok(agentMessagesAppendRequestSchema, { sessionId: "s1", messages: [{ ...message, content: big }] })).toBe(false);
  });
});

describe("agent pending actions", () => {
  const create = {
    sessionId: "s1",
    operation: "transactions.create",
    input: { type: "expense", accountId: "a1" },
    summary: "Add expense of 12.50 USD",
  };

  it("create takes a finance write operation, JSON input and a bounded ttl", () => {
    expect(ok(agentPendingActionCreateRequestSchema, create)).toBe(true);
    expect(ok(agentPendingActionCreateRequestSchema, { ...create, ttlSeconds: 600 })).toBe(true);
    expect(ok(agentPendingActionCreateRequestSchema, { ...create, ttlSeconds: 10 })).toBe(false);
    expect(ok(agentPendingActionCreateRequestSchema, { ...create, operation: "transactions.search" })).toBe(false);
    expect(ok(agentPendingActionCreateRequestSchema, { ...create, operation: "agentHistory.delete" })).toBe(false);
    expect(ok(agentPendingActionCreateRequestSchema, { ...create, summary: "  " })).toBe(false);
    expect(ok(agentPendingActionCreateRequestSchema, { ...create, input: { blob: "x".repeat(17 * 1024) } })).toBe(false);
  });

  it("create takes an optional clientKey for idempotent creation", () => {
    expect(ok(agentPendingActionCreateRequestSchema, { ...create, clientKey: "812345:0" })).toBe(true);
    expect(ok(agentPendingActionCreateRequestSchema, { ...create, clientKey: "" })).toBe(false);
    expect(ok(agentPendingActionCreateRequestSchema, { ...create, clientKey: "a b" })).toBe(false);
    expect(ok(agentPendingActionCreateRequestSchema, { ...create, clientKey: "k".repeat(129) })).toBe(false);
  });

  it("rejects JSON keys Convex can't store (leading $ or _, empty) at any depth", () => {
    for (const input of [
      { $set: 1 },
      { _id: "x" },
      { "": 1 },
      { a: { b: [{ $c: 1 }] } },
      { descrição: 1 }, // Convex field names are printable ASCII
      { "tab\there": 1 },
      { ["k".repeat(1025)]: 1 },
    ]) {
      expect(ok(agentPendingActionCreateRequestSchema, { ...create, input }), JSON.stringify(input)).toBe(false);
    }
    expect(ok(agentPendingActionCompleteRequestSchema, { id: "p1", status: "failed", result: { details: { _x: 1 } } })).toBe(false);
    expect(ok(agentPendingActionCompleteRequestSchema, { id: "p1", status: "failed", result: [{ $x: 1 }] })).toBe(false);
    expect(ok(agentPendingActionCreateRequestSchema, { ...create, input: { a: { "b-c": [1, "$ok", { d_: null }] } } })).toBe(true);
    // Too deep.
    let deep: unknown = 1;
    for (let i = 0; i < 20; i++) deep = { a: deep };
    expect(ok(agentPendingActionCompleteRequestSchema, { id: "p1", status: "failed", result: deep })).toBe(false);
  });

  it("complete needs a final status and a result", () => {
    expect(ok(agentPendingActionCompleteRequestSchema, { id: "p1", status: "executed", result: { id: "t1" } })).toBe(true);
    expect(ok(agentPendingActionCompleteRequestSchema, { id: "p1", status: "failed", result: null })).toBe(true);
    expect(ok(agentPendingActionCompleteRequestSchema, { id: "p1", status: "confirmed", result: {} })).toBe(false);
    expect(ok(agentPendingActionCompleteRequestSchema, { id: "p1", status: "executed" })).toBe(false);
  });

  it("parses an action", () => {
    expect(
      ok(agentPendingActionSchema, {
        id: "p1",
        sessionId: "s1",
        operation: "transactions.create",
        input: { amount: { amountMinor: 1250, currency: "USD" } },
        summary: "x",
        status: "pending",
        expiresAt: "2026-11-11T10:10:00.000Z",
        createdAt: "2026-11-11T10:00:00.000Z",
        updatedAt: "2026-11-11T10:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("history delete takes no input", () => {
    expect(ok(agentHistoryDeleteRequestSchema, {})).toBe(true);
    expect(ok(agentHistoryDeleteRequestSchema, { userId: "u" })).toBe(false);
  });
});

describe("resolve response scopes", () => {
  it("accepts agent:state next to the finance scopes", () => {
    const identity = {
      id: "ci1",
      channel: "telegram",
      externalUserId: "1",
      chatId: "1",
      scopes: ["finance:read"],
      linkedAt: "x",
      consentAt: "x",
    };
    expect(
      ok(channelIdentityResolveResponseSchema, {
        token: "t",
        expiresAt: "x",
        scopes: ["finance:read", "agent:state"],
        identity,
        profile: {},
      }),
    ).toBe(true);
    expect(
      ok(channelIdentityResolveResponseSchema, { token: "t", expiresAt: "x", scopes: ["admin"], identity, profile: {} }),
    ).toBe(false);
  });
});
