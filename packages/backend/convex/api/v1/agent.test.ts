import { routes, type ErrorCode } from "@mpf/finance-contract";
import { describe, expect, it, vi } from "vitest";

import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  expectApiError,
  expectConforms,
  expenseInput,
  linkedChat,
  raw,
  serviceClientFor,
  setupApi,
  TEST_SERVICE_KEY,
  tokenFor,
  type LinkedChat,
  type T,
} from "./test.helpers";

const TG = "telegram" as const;
const MIN = 60_000;
const json = (value: unknown) => JSON.stringify(value);

async function session(chat: LinkedChat, idleTimeoutMinutes = 30) {
  const { session } = await chat.agent.agentSessions.current({ channel: TG, chatId: chat.chatId, idleTimeoutMinutes });
  return session;
}

async function twoChats(t: T) {
  const alice = await linkedChat(t, { externalUserId: "1001", withAccount: true });
  const bob = await linkedChat(t, { externalUserId: "2002", withAccount: true });
  return { alice, bob };
}

async function newAction(chat: LinkedChat, options: { ttlSeconds?: number } = {}) {
  const s = await session(chat);
  const { action } = await chat.agent.agentPendingActions.create({
    sessionId: s.id,
    operation: "transactions.create",
    input: expenseInput(chat.accountId!),
    summary: "Add expense of 12.50 USD",
    ...options,
  });
  return { session: s, action };
}

const claim = (t: T, eventId: string, payload = json({ update_id: Number(eventId), message: { text: "hi" } })) =>
  serviceClientFor(t).agentEvents.claim({ channel: TG, eventId, payload });

const eventRow = (t: T, eventId: string) =>
  t.run((ctx) =>
    ctx.db
      .query("agentInboundEvents")
      .withIndex("by_channel_and_eventId", (q) => q.eq("channel", TG).eq("eventId", eventId))
      .unique(),
  );

/* -------------------------------------------------------------------------- */
/*  Inbound events (service key)                                              */
/* -------------------------------------------------------------------------- */

describe("agentEvents (service key)", () => {
  it("claims a new event once and reports later claims as duplicates", async () => {
    const t = setupApi();
    expect(await claim(t, "9001")).toEqual({ status: "new" });
    expect(await claim(t, "9001")).toEqual({ status: "duplicate" });
    expect(await claim(t, "9002")).toEqual({ status: "new" });
    const row = await eventRow(t, "9001");
    expect(row).toMatchObject({ status: "received", attempts: 0 });
    expect(JSON.parse(row!.payload)).toMatchObject({ update_id: 9001 });
  });

  it("a duplicate does not touch the stored event", async () => {
    const t = setupApi();
    await claim(t, "9001", json({ text: "first" }));
    await claim(t, "9001", json({ text: "second" }));
    expect(JSON.parse((await eventRow(t, "9001"))!.payload)).toEqual({ text: "first" });
  });

  it("only one of two concurrent claims is new", async () => {
    const t = setupApi();
    const results = await Promise.all([claim(t, "9001"), claim(t, "9001")]);
    expect(results.map((r) => r.status).sort()).toEqual(["duplicate", "new"]);
    expect(await t.run((ctx) => ctx.db.query("agentInboundEvents").collect())).toHaveLength(1);
  });

  it("rejects payloads that are not JSON or too large", async () => {
    const t = setupApi();
    const service = serviceClientFor(t);
    // The client checks the contract before sending; the server checks again.
    await expectApiError(service.agentEvents.claim({ channel: TG, eventId: "1", payload: "nope" }), "validation_failed");
    await expectApiError(
      service.agentEvents.claim({ channel: TG, eventId: "1", payload: json("x".repeat(33 * 1024)) }),
      "validation_failed",
    );
    for (const payload of ["nope", json("x".repeat(33 * 1024))]) {
      const response = await raw(t, "POST", "/agent/events/claim", {
        token: TEST_SERVICE_KEY,
        body: { channel: TG, eventId: "1", payload },
      });
      expect({ status: response.status, code: response.body.error?.code }).toEqual({ status: 400, code: "validation_failed" });
    }
    expect(await t.run((ctx) => ctx.db.query("agentInboundEvents").collect())).toHaveLength(0);
  });

  it("walks received -> processing -> done, counting attempts and dropping the payload", async () => {
    const t = setupApi();
    const service = serviceClientFor(t);
    await claim(t, "9001");

    const processing = await service.agentEvents.updateStatus({ channel: TG, eventId: "9001", status: "processing" });
    expect(processing.event).toMatchObject({ eventId: "9001", status: "processing", attempts: 1 });
    const again = await service.agentEvents.updateStatus({ channel: TG, eventId: "9001", status: "processing" });
    expect(again.event.attempts).toBe(2);

    const done = await service.agentEvents.updateStatus({ channel: TG, eventId: "9001", status: "done" });
    expect(done.event).toMatchObject({ status: "done", attempts: 2 });
    // Message text is not kept once the event is finished.
    expect((await eventRow(t, "9001"))!.payload).toBe("");
  });

  it("stores the error of a failed event and drops its payload", async () => {
    const t = setupApi();
    const service = serviceClientFor(t);
    await claim(t, "9001");
    const failed = await service.agentEvents.updateStatus({ channel: TG, eventId: "9001", status: "failed", error: "LLM timeout" });
    expect(failed.event).toMatchObject({ status: "failed", error: "LLM timeout" });
    expect((await eventRow(t, "9001"))!.payload).toBe("");
  });

  it("done and failed are final", async () => {
    const t = setupApi();
    const service = serviceClientFor(t);
    for (const [eventId, status] of [["1", "done"], ["2", "failed"]] as const) {
      await claim(t, eventId);
      await service.agentEvents.updateStatus({ channel: TG, eventId, status });
      for (const next of ["processing", "done", "failed"] as const) {
        await expectApiError(service.agentEvents.updateStatus({ channel: TG, eventId, status: next }), "conflict", 409);
      }
      expect((await eventRow(t, eventId))!.status).toBe(status);
    }
  });

  it("returns not_found for an event that was never claimed", async () => {
    const t = setupApi();
    await expectApiError(
      serviceClientFor(t).agentEvents.updateStatus({ channel: TG, eventId: "404", status: "done" }),
      "not_found",
      404,
    );
  });

  describe("listRecoverable", () => {
    const age = (t: T, eventId: string, ms: number) =>
      t.run(async (ctx) => {
        const row = (await ctx.db
          .query("agentInboundEvents")
          .withIndex("by_channel_and_eventId", (q) => q.eq("channel", TG).eq("eventId", eventId))
          .unique())!;
        await ctx.db.patch(row._id, { updatedAt: Date.now() - ms });
      });

    it("lists received and processing events older than the threshold, oldest first, with their payload", async () => {
      const t = setupApi();
      const service = serviceClientFor(t);
      for (const id of ["1", "2", "3", "4", "5"]) await claim(t, id);
      await service.agentEvents.updateStatus({ channel: TG, eventId: "2", status: "processing" });
      await service.agentEvents.updateStatus({ channel: TG, eventId: "3", status: "done" });
      await service.agentEvents.updateStatus({ channel: TG, eventId: "4", status: "failed" });
      await age(t, "1", 5 * MIN);
      await age(t, "2", 10 * MIN);
      await age(t, "3", 10 * MIN);
      await age(t, "4", 10 * MIN);
      // "5" is fresh.

      const { items } = await service.agentEvents.listRecoverable({ channel: TG, olderThanSeconds: 60 });
      expect(items.map((e) => e.eventId)).toEqual(["2", "1"]);
      expect(items[0]).toMatchObject({ status: "processing", attempts: 1 });
      expect(JSON.parse(items[1]!.payload)).toMatchObject({ update_id: 1 });
    });

    it("skips events that used up their attempts and honours the limit", async () => {
      const t = setupApi();
      const service = serviceClientFor(t);
      for (const id of ["1", "2", "3"]) {
        await claim(t, id);
        await age(t, id, 5 * MIN);
      }
      for (let i = 0; i < 3; i++) await service.agentEvents.updateStatus({ channel: TG, eventId: "1", status: "processing" });
      await age(t, "1", 10 * MIN);

      const defaults = await service.agentEvents.listRecoverable({ channel: TG, olderThanSeconds: 60 });
      expect(defaults.items.map((e) => e.eventId)).toEqual(["2", "3"]);
      const more = await service.agentEvents.listRecoverable({ channel: TG, olderThanSeconds: 60, maxAttempts: 4 });
      expect(more.items.map((e) => e.eventId)).toEqual(["1", "2", "3"]);
      const limited = await service.agentEvents.listRecoverable({ channel: TG, olderThanSeconds: 60, maxAttempts: 4, limit: 2 });
      expect(limited.items.map((e) => e.eventId)).toEqual(["1", "2"]);
    });

    it("is empty when nothing is stuck", async () => {
      const t = setupApi();
      await claim(t, "1");
      expect(await serviceClientFor(t).agentEvents.listRecoverable({ channel: TG, olderThanSeconds: 60 })).toEqual({ items: [] });
    });

    it("works over raw HTTP with query strings", async () => {
      const t = setupApi();
      await claim(t, "1");
      await age(t, "1", 5 * MIN);
      const response = await raw(t, "GET", "/agent/events/recoverable?channel=telegram&olderThanSeconds=60&limit=5", {
        token: TEST_SERVICE_KEY,
      });
      const data = expectConforms(routes.agentEvents.listRecoverable, response) as { items: unknown[] };
      expect(data.items).toHaveLength(1);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Auth: scopes, credentials, revocation                                     */
/* -------------------------------------------------------------------------- */

describe("agent routes auth", () => {
  const sessionInput = (chat: LinkedChat) => ({ channel: TG, chatId: chat.chatId, idleTimeoutMinutes: 30 });
  const calls = (t: T, token: string, chat: LinkedChat) => {
    const request = (method: string, path: string, body?: unknown) => raw(t, method, path, { token, ...(body === undefined ? {} : { body }) });
    return [
      ["agentSessions.current", () => request("POST", "/agent/sessions/current", sessionInput(chat))],
      ["agentMessages.list", () => request("GET", "/agent/sessions/missing/messages")],
      ["agentMessages.append", () => request("POST", "/agent/sessions/missing/messages", { messages: [{ role: "user", content: "{}" }] })],
      ["agentPendingActions.get", () => request("GET", "/agent/pending-actions/missing")],
      ["agentPendingActions.confirm", () => request("POST", "/agent/pending-actions/missing/confirm", {})],
      ["agentPendingActions.cancel", () => request("POST", "/agent/pending-actions/missing/cancel", {})],
      ["agentHistory.delete", () => request("DELETE", "/agent/history")],
    ] as const;
  };

  it("grants agent:state on every resolved token, read-only identities included", async () => {
    const t = setupApi();
    const rw = await linkedChat(t, { externalUserId: "1001" });
    const ro = await linkedChat(t, { externalUserId: "2002", readOnly: true });
    expect(rw.resolved.scopes).toContain("agent:state");
    expect(ro.resolved.scopes).toEqual(["finance:read", "agent:state"]);
    // Read-only users keep conversation state but still can't write finance data.
    const s = await session(ro);
    await ro.agent.agentMessages.append({ sessionId: s.id, messages: [{ role: "user", content: json({ text: "hi" }) }] });
  });

  it("forbids a token without agent:state on every agent route, finance scopes or not", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    const financeOnly = await tokenFor(chat.userId, ["finance:read", "finance:write"]);
    for (const [name, call] of calls(t, financeOnly, chat)) {
      const response = await call();
      expect({ name, status: response.status, code: response.body.error?.code }).toEqual({ name, status: 403, code: "forbidden" });
    }
  });

  it("an agent:state-only token can't use finance routes", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const agentOnly = await tokenFor(chat.userId, ["agent:state"]);
    expect((await raw(t, "GET", "/accounts", { token: agentOnly })).body.error?.code).toBe("forbidden");
    expect(
      (await raw(t, "POST", "/accounts/x/adjustments", { token: agentOnly, idempotencyKey: "k-agent-0001", body: {} })).body.error?.code,
    ).toBe("forbidden");
  });

  it("forbids an agent:state token that has no channel identity", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    const noCid = await tokenFor(chat.userId, ["agent:state"]);
    for (const [name, call] of calls(t, noCid, chat)) {
      const response = await call();
      expect({ name, status: response.status }).toEqual({ name, status: 403 });
    }
  });

  it("the service key is not accepted on agent user routes, and a user token not on event routes", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    for (const [name, call] of calls(t, TEST_SERVICE_KEY, chat)) {
      const response = await call();
      expect({ name, status: response.status, code: response.body.error?.code }).toEqual({ name, status: 401, code: "unauthorized" });
    }
    const event = { channel: TG, eventId: "1", payload: "{}" };
    const withUserToken = await raw(t, "POST", "/agent/events/claim", { token: chat.token, body: event });
    expect(withUserToken.status).toBe(401);
    expect(await t.run((ctx) => ctx.db.query("agentInboundEvents").collect())).toHaveLength(0);
  });

  it("stops working the moment the identity is unlinked", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    await session(chat);
    await chat.service.channelIdentities.unlink({ channel: TG, externalUserId: chat.chat.externalUserId });
    for (const [name, call] of calls(t, chat.token, chat)) {
      const response = await call();
      expect({ name, status: response.status }).toEqual({ name, status: 401 });
    }
  });

  it("accepts no Idempotency-Key and ignores one if sent", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    const response = await raw(t, "POST", "/agent/sessions/current", {
      token: chat.token,
      body: sessionInput(chat),
      idempotencyKey: "whatever-key-0001",
    });
    expect(response.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/*  Sessions                                                                  */
/* -------------------------------------------------------------------------- */

describe("agentSessions.current", () => {
  it("creates a session for the chat and returns the same one while it is active", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    const first = await chat.agent.agentSessions.current({ channel: TG, chatId: chat.chatId, idleTimeoutMinutes: 30 });
    expect(first.created).toBe(true);
    expect(first.session).toMatchObject({ channel: TG, chatId: chat.chatId, messageCount: 0 });
    expect(first.session.endedAt).toBeUndefined();

    const second = await chat.agent.agentSessions.current({ channel: TG, chatId: chat.chatId, idleTimeoutMinutes: 30 });
    expect(second).toMatchObject({ created: false, session: { id: first.session.id } });

    const stored = await t.run((ctx) => ctx.db.query("agentSessions").collect());
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ userId: chat.userId, identityId: chat.identityId, channel: TG, chatId: chat.chatId });
  });

  it("ends an idle session and starts a new one", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    const first = await session(chat, 30);
    await t.run((ctx) => ctx.db.patch(first.id as unknown as Id<"agentSessions">, { lastActivityAt: Date.now() - 31 * MIN }));

    const next = await chat.agent.agentSessions.current({ channel: TG, chatId: chat.chatId, idleTimeoutMinutes: 30 });
    expect(next.created).toBe(true);
    expect(next.session.id).not.toBe(first.id);

    const old = await t.run((ctx) => ctx.db.get(first.id as unknown as Id<"agentSessions">));
    expect(old!.endedAt).toBeGreaterThan(0);
    const active = (await t.run((ctx) => ctx.db.query("agentSessions").collect())).filter((s) => s.endedAt === undefined);
    expect(active.map((s) => s._id as string)).toEqual([next.session.id]);
  });

  it("keeps a session that is idle for less than the timeout", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    const first = await session(chat, 30);
    await t.run((ctx) => ctx.db.patch(first.id as unknown as Id<"agentSessions">, { lastActivityAt: Date.now() - 29 * MIN }));
    const again = await chat.agent.agentSessions.current({ channel: TG, chatId: chat.chatId, idleTimeoutMinutes: 30 });
    expect(again).toMatchObject({ created: false, session: { id: first.id } });
    // The same session counts as idle with a shorter timeout.
    const shorter = await chat.agent.agentSessions.current({ channel: TG, chatId: chat.chatId, idleTimeoutMinutes: 10 });
    expect(shorter.created).toBe(true);
  });

  it("startNew ends the active session even when it is fresh", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    const first = await session(chat);
    const next = await chat.agent.agentSessions.current({ channel: TG, chatId: chat.chatId, idleTimeoutMinutes: 30, startNew: true });
    expect(next.created).toBe(true);
    expect(next.session.id).not.toBe(first.id);
    expect((await t.run((ctx) => ctx.db.get(first.id as unknown as Id<"agentSessions">)))!.endedAt).toBeGreaterThan(0);
  });

  it("only serves the chat the token was resolved for", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    await expectApiError(
      chat.agent.agentSessions.current({ channel: TG, chatId: "999", idleTimeoutMinutes: 30 }),
      "validation_failed",
      400,
    );
    expect(await t.run((ctx) => ctx.db.query("agentSessions").collect())).toHaveLength(0);
  });

  it("gives each user their own session", async () => {
    const t = setupApi();
    const { alice, bob } = await twoChats(t);
    const a = await session(alice);
    const b = await session(bob);
    expect(a.id).not.toBe(b.id);
    expect((await session(alice)).id).toBe(a.id);
  });
});

/* -------------------------------------------------------------------------- */
/*  Messages                                                                  */
/* -------------------------------------------------------------------------- */

describe("agentMessages", () => {
  const msg = (role: "user" | "assistant" | "tool" | "system", text: string) => ({ role, content: json({ text }) });

  it("appends in order and lists the latest N oldest first", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    const s = await session(chat);
    const appended = await chat.agent.agentMessages.append({
      sessionId: s.id,
      messages: [msg("user", "m1"), msg("assistant", "m2"), msg("tool", "m3")],
    });
    expect(appended.items.map((m) => m.seq)).toEqual([1, 2, 3]);
    await chat.agent.agentMessages.append({ sessionId: s.id, messages: [msg("system", "m4"), msg("user", "m5")] });

    const all = await chat.agent.agentMessages.list({ sessionId: s.id });
    expect(all.items.map((m) => JSON.parse(m.content).text)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(all.items.map((m) => m.role)).toEqual(["user", "assistant", "tool", "system", "user"]);

    const latest = await chat.agent.agentMessages.list({ sessionId: s.id, limit: 2 });
    expect(latest.items.map((m) => JSON.parse(m.content).text)).toEqual(["m4", "m5"]);
    expect(latest.items.every((m) => m.sessionId === s.id)).toBe(true);
  });

  it("stores content as given and defaults the limit to 50", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    const s = await session(chat);
    const content = json({ role: "assistant", parts: [{ type: "tool_use", name: "x", input: { $weird: 1, _k: "é" } }] });
    await chat.agent.agentMessages.append({ sessionId: s.id, messages: [{ role: "assistant", content }] });
    expect((await chat.agent.agentMessages.list({ sessionId: s.id })).items[0]!.content).toBe(content);

    for (let batch = 0; batch < 3; batch++) {
      await chat.agent.agentMessages.append({
        sessionId: s.id,
        messages: Array.from({ length: 20 }, (_, i) => msg("user", `b${batch}-${i}`)),
      });
    }
    const list = await chat.agent.agentMessages.list({ sessionId: s.id });
    expect(list.items).toHaveLength(50);
    expect(list.items.at(-1)!.seq).toBe(61);
  });

  it("bumps lastActivityAt and the message count", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    const s = await session(chat);
    await t.run((ctx) => ctx.db.patch(s.id as unknown as Id<"agentSessions">, { lastActivityAt: Date.now() - 20 * MIN }));
    await chat.agent.agentMessages.append({ sessionId: s.id, messages: [msg("user", "a"), msg("assistant", "b")] });
    const stored = await t.run((ctx) => ctx.db.get(s.id as unknown as Id<"agentSessions">));
    expect(stored!.messageCount).toBe(2);
    expect(Date.now() - stored!.lastActivityAt).toBeLessThan(5_000);
    // So the session is no longer idle.
    expect((await chat.agent.agentSessions.current({ channel: TG, chatId: chat.chatId, idleTimeoutMinutes: 10 })).created).toBe(false);
  });

  it("caps a session at 500 messages: past it append is a conflict and stores nothing", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    const s = await session(chat);
    await t.run((ctx) => ctx.db.patch(s.id as unknown as Id<"agentSessions">, { messageCount: 498 }));

    await expectApiError(
      chat.agent.agentMessages.append({ sessionId: s.id, messages: [msg("user", "a"), msg("user", "b"), msg("user", "c")] }),
      "conflict",
      409,
    );
    expect(await t.run((ctx) => ctx.db.query("agentMessages").collect())).toHaveLength(0);

    await chat.agent.agentMessages.append({ sessionId: s.id, messages: [msg("user", "a"), msg("user", "b")] });
    await expectApiError(chat.agent.agentMessages.append({ sessionId: s.id, messages: [msg("user", "c")] }), "conflict", 409);
    expect(await t.run((ctx) => ctx.db.query("agentMessages").collect())).toHaveLength(2);

    // The agent starts a new session and carries on.
    const next = await chat.agent.agentSessions.current({ channel: TG, chatId: chat.chatId, idleTimeoutMinutes: 30, startNew: true });
    await chat.agent.agentMessages.append({ sessionId: next.session.id, messages: [msg("user", "c")] });
  });

  it("refuses to append to an ended session but still lists it", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    const s = await session(chat);
    await chat.agent.agentMessages.append({ sessionId: s.id, messages: [msg("user", "a")] });
    await chat.agent.agentSessions.current({ channel: TG, chatId: chat.chatId, idleTimeoutMinutes: 30, startNew: true });
    await expectApiError(chat.agent.agentMessages.append({ sessionId: s.id, messages: [msg("user", "b")] }), "conflict", 409);
    expect((await chat.agent.agentMessages.list({ sessionId: s.id })).items).toHaveLength(1);
  });

  it("validates content, role, batch size and the session id", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    const s = await session(chat);
    await expectApiError(chat.agent.agentMessages.append({ sessionId: s.id, messages: [{ role: "user", content: "{nope" }] }), "validation_failed");
    await expectApiError(chat.agent.agentMessages.append({ sessionId: s.id, messages: [] }), "validation_failed");
    await expectApiError(
      chat.agent.agentMessages.append({ sessionId: s.id, messages: [{ role: "user", content: json("x".repeat(33 * 1024)) }] }),
      "validation_failed",
    );
    const tooBig = await raw(t, "POST", `/agent/sessions/${s.id}/messages`, {
      token: chat.token,
      body: { messages: [{ role: "user", content: json("x".repeat(33 * 1024)) }] },
    });
    expect(tooBig.status).toBe(400);
    const bad = await raw(t, "POST", `/agent/sessions/${s.id}/messages`, {
      token: chat.token,
      body: { messages: [{ role: "bot", content: "{}" }] },
    });
    expect(bad.status).toBe(400);
    await expectApiError(chat.agent.agentMessages.list({ sessionId: "does-not-exist" }), "not_found", 404);
    await expectApiError(chat.agent.agentMessages.list({ sessionId: s.id, limit: 500 }), "validation_failed");
    expect(await t.run((ctx) => ctx.db.query("agentMessages").collect())).toHaveLength(0);
  });

  it("another user can't read or append to the session", async () => {
    const t = setupApi();
    const { alice, bob } = await twoChats(t);
    const s = await session(alice);
    await alice.agent.agentMessages.append({ sessionId: s.id, messages: [msg("user", "secret")] });

    await expectApiError(bob.agent.agentMessages.list({ sessionId: s.id }), "not_found", 404);
    await expectApiError(bob.agent.agentMessages.append({ sessionId: s.id, messages: [msg("user", "x")] }), "not_found", 404);
    expect((await alice.agent.agentMessages.list({ sessionId: s.id })).items).toHaveLength(1);
  });

  it("a session id of another table is not_found, not an error", async () => {
    const t = setupApi();
    const { alice } = await twoChats(t);
    await expectApiError(alice.agent.agentMessages.list({ sessionId: alice.accountId as string }), "not_found", 404);
  });
});

/* -------------------------------------------------------------------------- */
/*  Pending actions                                                           */
/* -------------------------------------------------------------------------- */

describe("agentPendingActions", () => {
  it("creates a pending action with the default and a custom ttl", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const { action, session: s } = await newAction(chat);
    expect(action).toMatchObject({
      sessionId: s.id,
      operation: "transactions.create",
      summary: "Add expense of 12.50 USD",
      status: "pending",
      input: expenseInput(chat.accountId!),
    });
    expect(action.result).toBeUndefined();
    const ttl = new Date(action.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * MIN);
    expect(ttl).toBeLessThanOrEqual(10 * MIN);

    const short = (await newAction(chat, { ttlSeconds: 60 })).action;
    expect(new Date(short.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60_000);
  });

  it("a clientKey makes create idempotent per session: a repeat returns the existing action in any status", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const s = await session(chat);
    const create = (amountMinor = 1250, clientKey = "5001:0") =>
      chat.agent.agentPendingActions.create({
        sessionId: s.id,
        operation: "transactions.create",
        input: expenseInput(chat.accountId!, amountMinor),
        summary: `Expense ${amountMinor}`,
        clientKey,
      });
    const first = (await create()).action;
    expect(first.clientKey).toBe("5001:0");
    // Same key: same action, even when the replayed proposal differs. Nothing new is stored.
    const again = (await create(999)).action;
    expect(again).toMatchObject({ id: first.id, summary: "Expense 1250", input: expenseInput(chat.accountId!) });
    await chat.agent.agentPendingActions.confirm({ id: first.id });
    expect((await create()).action).toMatchObject({ id: first.id, status: "confirmed" });
    // Another key is another action.
    expect((await create(1250, "5001:1")).action.id).not.toBe(first.id);
    expect(await t.run((ctx) => ctx.db.query("agentPendingActions").collect())).toHaveLength(2);
  });

  it("a clientKey is scoped to the session, and a repeat still needs write access", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const first = await session(chat);
    const input = { operation: "transactions.create" as const, input: expenseInput(chat.accountId!), summary: "x", clientKey: "k1" };
    const a = (await chat.agent.agentPendingActions.create({ sessionId: first.id, ...input })).action;
    const { session: second } = await chat.agent.agentSessions.current({ channel: TG, chatId: chat.chatId, idleTimeoutMinutes: 30, startNew: true });
    const b = (await chat.agent.agentPendingActions.create({ sessionId: second.id, ...input })).action;
    expect(b.id).not.toBe(a.id);

    await chat.web.mutation(api.channelLinks.setReadOnly, { identityId: chat.identityId, readOnly: true });
    await expectApiError(chat.agent.agentPendingActions.create({ sessionId: second.id, ...input }), "forbidden", 403);
  });

  it("validates the input against the operation's own schema", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const s = await session(chat);
    const bad = chat.agent.agentPendingActions.create({
      sessionId: s.id,
      operation: "transactions.create",
      input: { type: "expense", accountId: chat.accountId! },
      summary: "broken",
    });
    const error = await expectApiError(bad, "validation_failed", 400);
    expect(JSON.stringify(error.details)).toContain("amount");
    await expectApiError(
      chat.agent.agentPendingActions.create({
        sessionId: s.id,
        operation: "transactions.create",
        input: { ...expenseInput(chat.accountId!), userId: "someone-else" },
        summary: "extra key",
      }),
      "validation_failed",
      400,
    );
    expect(await t.run((ctx) => ctx.db.query("agentPendingActions").collect())).toHaveLength(0);
  });

  it("rejects read operations and unknown operations", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const s = await session(chat);
    for (const operation of ["transactions.search", "agentHistory.delete", "nope"]) {
      const response = await raw(t, "POST", "/agent/pending-actions", {
        token: chat.token,
        body: { sessionId: s.id, operation, input: {}, summary: "x" },
      });
      expect({ operation, status: response.status }).toEqual({ operation, status: 400 });
    }
  });

  it("limits pending actions per session and ignores expired ones in the count", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const { session: s } = await newAction(chat);
    for (let i = 1; i < 20; i++) await newAction(chat);
    await expectApiError(
      chat.agent.agentPendingActions.create({ sessionId: s.id, operation: "transactions.create", input: expenseInput(chat.accountId!), summary: "21st" }),
      "conflict",
      409,
    );
    await t.run(async (ctx) => {
      const first = (await ctx.db.query("agentPendingActions").first())!;
      await ctx.db.patch(first._id, { expiresAt: Date.now() - 1_000 });
    });
    await newAction(chat);
  });

  it("expired-but-pending rows can't be used to get past the per-session limit", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const { session: s } = await newAction(chat);
    await t.run(async (ctx) => {
      const first = (await ctx.db.query("agentPendingActions").first())!;
      for (let i = 0; i < 30; i++) {
        await ctx.db.insert("agentPendingActions", {
          ...(({ _id, _creationTime, ...rest }) => rest)(first),
          expiresAt: Date.now() - 1_000,
        });
      }
      await ctx.db.patch(first._id, { expiresAt: Date.now() - 1_000 });
    });
    // 31 expired rows are still `pending`: creating works and sweeps them to `expired`.
    await chat.agent.agentPendingActions.create({
      sessionId: s.id,
      operation: "transactions.create",
      input: expenseInput(chat.accountId!),
      summary: "fresh",
    });
    const rows = await t.run((ctx) => ctx.db.query("agentPendingActions").collect());
    expect(rows).toHaveLength(32);
    expect(rows.filter((a) => a.status === "expired")).toHaveLength(31);
    expect(rows.filter((a) => a.status === "pending").map((a) => a.summary)).toEqual(["fresh"]);

    // And the limit still bites once 20 live ones exist.
    for (let i = 1; i < 20; i++) await newAction(chat);
    await expectApiError(
      chat.agent.agentPendingActions.create({ sessionId: s.id, operation: "transactions.create", input: expenseInput(chat.accountId!), summary: "too many" }),
      "conflict",
      409,
    );
  });

  it("a read-only identity can't create or confirm a write action", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const { action } = await newAction(chat);
    await chat.web.mutation(api.channelLinks.setReadOnly, { identityId: chat.identityId, readOnly: true });

    // The existing token still carries finance:write, but the identity no longer does.
    await expectApiError(chat.agent.agentPendingActions.confirm({ id: action.id }), "forbidden", 403);
    expect((await chat.agent.agentPendingActions.get({ id: action.id })).action.status).toBe("pending");
    await expectApiError(
      chat.agent.agentPendingActions.create({
        sessionId: action.sessionId,
        operation: "transactions.create",
        input: expenseInput(chat.accountId!),
        summary: "nope",
      }),
      "forbidden",
      403,
    );
    // Cancelling a button is not a write.
    expect((await chat.agent.agentPendingActions.cancel({ id: action.id })).action.status).toBe("cancelled");

    const readOnly = await linkedChat(t, { externalUserId: "3003", readOnly: true, withAccount: true });
    const s = await session(readOnly);
    await expectApiError(
      readOnly.agent.agentPendingActions.create({ sessionId: s.id, operation: "transactions.create", input: expenseInput(readOnly.accountId!), summary: "x" }),
      "forbidden",
      403,
    );
  });

  it("confirm still works after the session was ended by idle rollover", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const { action } = await newAction(chat);
    await chat.agent.agentSessions.current({ channel: TG, chatId: chat.chatId, idleTimeoutMinutes: 30, startNew: true });
    expect((await chat.agent.agentPendingActions.confirm({ id: action.id })).action.status).toBe("confirmed");
  });

  it("rejects JSON keys Convex can't store with validation_failed, not a 500", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const s = await session(chat);
    const create = await raw(t, "POST", "/agent/pending-actions", {
      token: chat.token,
      body: { sessionId: s.id, operation: "transactions.create", input: { $set: 1 }, summary: "x" },
    });
    expect(create.status).toBe(400);
    const { action } = await newAction(chat);
    await chat.agent.agentPendingActions.confirm({ id: action.id });
    const complete = await raw(t, "POST", `/agent/pending-actions/${action.id}/complete`, {
      token: chat.token,
      body: { status: "failed", result: { _bad: true } },
    });
    expect(complete.status).toBe(400);
    const accented = await raw(t, "POST", `/agent/pending-actions/${action.id}/complete`, {
      token: chat.token,
      body: { status: "failed", result: { descrição: "x" } },
    });
    expect(accented.status).toBe(400);
    // Nesting deep enough to overflow the validator's stack is a 400, not a 500.
    const deep = `{"status":"failed","result":${"[".repeat(30_000)}${"]".repeat(30_000)}}`;
    const nested = await raw(t, "POST", `/agent/pending-actions/${action.id}/complete`, { token: chat.token, rawBody: deep });
    expect({ status: nested.status, code: nested.body.error?.code }).toEqual({ status: 400, code: "validation_failed" });
    expect((await chat.agent.agentPendingActions.get({ id: action.id })).action.status).toBe("confirmed");
  });

  it("only the session owner can create an action in it, and not in an ended session", async () => {
    const t = setupApi();
    const { alice, bob } = await twoChats(t);
    const s = await session(alice);
    await expectApiError(
      bob.agent.agentPendingActions.create({ sessionId: s.id, operation: "transactions.create", input: expenseInput(bob.accountId!), summary: "x" }),
      "not_found",
      404,
    );
    await alice.agent.agentSessions.current({ channel: TG, chatId: alice.chatId, idleTimeoutMinutes: 30, startNew: true });
    await expectApiError(
      alice.agent.agentPendingActions.create({ sessionId: s.id, operation: "transactions.create", input: expenseInput(alice.accountId!), summary: "x" }),
      "conflict",
      409,
    );
  });

  it("confirm moves pending to confirmed and returns the stored operation and input", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const { action } = await newAction(chat);
    const confirmed = await chat.agent.agentPendingActions.confirm({ id: action.id });
    expect(confirmed.action).toMatchObject({
      id: action.id,
      status: "confirmed",
      operation: "transactions.create",
      input: expenseInput(chat.accountId!),
    });
    expect((await chat.agent.agentPendingActions.get({ id: action.id })).action.status).toBe("confirmed");
  });

  it("confirming twice is a conflict, and so is confirming a cancelled action", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const first = (await newAction(chat)).action;
    await chat.agent.agentPendingActions.confirm({ id: first.id });
    const twice = await expectApiError(chat.agent.agentPendingActions.confirm({ id: first.id }), "conflict", 409);
    expect(twice.message).toContain("confirmed");

    const second = (await newAction(chat)).action;
    await chat.agent.agentPendingActions.cancel({ id: second.id });
    await expectApiError(chat.agent.agentPendingActions.confirm({ id: second.id }), "conflict", 409);
  });

  it("of two concurrent confirms exactly one wins", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const { action } = await newAction(chat);
    const results = await Promise.allSettled([
      chat.agent.agentPendingActions.confirm({ id: action.id }),
      chat.agent.agentPendingActions.confirm({ id: action.id }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "conflict" });
  });

  it("confirming an expired action is a conflict and marks it expired", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const { action } = await newAction(chat);
    await t.run((ctx) => ctx.db.patch(action.id as unknown as Id<"agentPendingActions">, { expiresAt: Date.now() - 1_000 }));
    const error = await expectApiError(chat.agent.agentPendingActions.confirm({ id: action.id }), "conflict", 409);
    expect(error.message).toContain("expired");
    // The expired mark survives the error response.
    expect((await chat.agent.agentPendingActions.get({ id: action.id })).action.status).toBe("expired");
    await expectApiError(chat.agent.agentPendingActions.confirm({ id: action.id }), "conflict", 409);
  });

  it("cancel works on pending actions only", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const pending = (await newAction(chat)).action;
    expect((await chat.agent.agentPendingActions.cancel({ id: pending.id })).action.status).toBe("cancelled");
    await expectApiError(chat.agent.agentPendingActions.cancel({ id: pending.id }), "conflict", 409);

    const confirmed = (await newAction(chat)).action;
    await chat.agent.agentPendingActions.confirm({ id: confirmed.id });
    await expectApiError(chat.agent.agentPendingActions.cancel({ id: confirmed.id }), "conflict", 409);
    expect((await chat.agent.agentPendingActions.get({ id: confirmed.id })).action.status).toBe("confirmed");

    const stale = (await newAction(chat)).action;
    await t.run((ctx) => ctx.db.patch(stale.id as unknown as Id<"agentPendingActions">, { expiresAt: Date.now() - 1_000 }));
    await expectApiError(chat.agent.agentPendingActions.cancel({ id: stale.id }), "conflict", 409);
    expect((await chat.agent.agentPendingActions.get({ id: stale.id })).action.status).toBe("expired");
  });

  it("complete records the outcome of a confirmed action, once", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const { action } = await newAction(chat);
    await expectApiError(
      chat.agent.agentPendingActions.complete({ id: action.id, status: "executed", result: { id: "t1" } }),
      "conflict",
      409,
    );
    await chat.agent.agentPendingActions.confirm({ id: action.id });
    const done = await chat.agent.agentPendingActions.complete({ id: action.id, status: "executed", result: { transaction: { id: "t1" } } });
    expect(done.action).toMatchObject({ status: "executed", result: { transaction: { id: "t1" } } });
    expect((await chat.agent.agentPendingActions.get({ id: action.id })).action).toMatchObject({
      status: "executed",
      result: { transaction: { id: "t1" } },
    });
    await expectApiError(chat.agent.agentPendingActions.complete({ id: action.id, status: "failed", result: null }), "conflict", 409);
    await expectApiError(chat.agent.agentPendingActions.cancel({ id: action.id }), "conflict", 409);
  });

  it("complete can record a failure", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const { action } = await newAction(chat);
    await chat.agent.agentPendingActions.confirm({ id: action.id });
    const failed = await chat.agent.agentPendingActions.complete({
      id: action.id,
      status: "failed",
      result: { code: "validation_failed", message: "Account is archived" },
    });
    expect(failed.action).toMatchObject({ status: "failed", result: { code: "validation_failed" } });
  });

  it("the confirmed input runs through the finance API with the action id as Idempotency-Key", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const { action } = await newAction(chat);
    const confirmed = (await chat.agent.agentPendingActions.confirm({ id: action.id })).action;
    const create = () => chat.finance.transactions.create(confirmed.input as never, { idempotencyKey: confirmed.id });
    const first = await create();
    const replay = await create();
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(await t.run((ctx) => ctx.db.query("transactions").collect())).toHaveLength(1);
  });

  it("another user can't get, confirm, cancel or complete the action", async () => {
    const t = setupApi();
    const { alice, bob } = await twoChats(t);
    const { action } = await newAction(alice);
    await alice.agent.agentPendingActions.confirm({ id: action.id });

    await expectApiError(bob.agent.agentPendingActions.get({ id: action.id }), "not_found", 404);
    await expectApiError(bob.agent.agentPendingActions.confirm({ id: action.id }), "not_found", 404);
    await expectApiError(bob.agent.agentPendingActions.cancel({ id: action.id }), "not_found", 404);
    await expectApiError(bob.agent.agentPendingActions.complete({ id: action.id, status: "executed", result: {} }), "not_found", 404);
    expect((await alice.agent.agentPendingActions.get({ id: action.id })).action.status).toBe("confirmed");

    // Confirming a pending one is refused too, and leaves it pending.
    const pending = (await newAction(alice)).action;
    await expectApiError(bob.agent.agentPendingActions.confirm({ id: pending.id }), "not_found", 404);
    expect((await alice.agent.agentPendingActions.get({ id: pending.id })).action.status).toBe("pending");
  });

  it("unknown and malformed ids are not_found / validation_failed", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    await expectApiError(chat.agent.agentPendingActions.get({ id: "missing" }), "not_found", 404);
    await expectApiError(chat.agent.agentPendingActions.confirm({ id: chat.accountId ?? chat.identityId }), "not_found", 404);
    expect((await raw(t, "GET", "/agent/pending-actions/bad%3Bid", { token: chat.token })).status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/*  History deletion                                                          */
/* -------------------------------------------------------------------------- */

describe("agentHistory.delete", () => {
  async function fill(chat: LinkedChat) {
    const { session: s, action } = await newAction(chat);
    await chat.agent.agentMessages.append({ sessionId: s.id, messages: [{ role: "user", content: json({ text: "hi" }) }] });
    return { s, action };
  }
  const counts = (t: T) =>
    t.run(async (ctx) => ({
      sessions: (await ctx.db.query("agentSessions").collect()).length,
      messages: (await ctx.db.query("agentMessages").collect()).length,
      actions: (await ctx.db.query("agentPendingActions").collect()).length,
    }));

  it("deletes the user's sessions, messages and actions, and nobody else's", async () => {
    const t = setupApi();
    const { alice, bob } = await twoChats(t);
    const { s: aliceSession, action } = await fill(alice);
    const { s: bobSession, action: bobAction } = await fill(bob);
    // An older, ended session goes too.
    await alice.agent.agentSessions.current({ channel: TG, chatId: alice.chatId, idleTimeoutMinutes: 30, startNew: true });

    expect(await alice.agent.agentHistory.delete()).toEqual({ deleted: true });
    expect(await counts(t)).toEqual({ sessions: 1, messages: 1, actions: 1 });
    await expectApiError(alice.agent.agentMessages.list({ sessionId: aliceSession.id }), "not_found", 404);
    await expectApiError(alice.agent.agentPendingActions.get({ id: action.id }), "not_found", 404);
    expect((await bob.agent.agentMessages.list({ sessionId: bobSession.id })).items).toHaveLength(1);
    expect((await bob.agent.agentPendingActions.get({ id: bobAction.id })).action.status).toBe("pending");
    // A fresh session starts cleanly.
    expect((await alice.agent.agentSessions.current({ channel: TG, chatId: alice.chatId, idleTimeoutMinutes: 30 })).created).toBe(true);
  });

  it("is fine on an empty history", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    expect(await chat.agent.agentHistory.delete()).toEqual({ deleted: true });
  });
});

/* -------------------------------------------------------------------------- */
/*  Unlink and the web button                                                 */
/* -------------------------------------------------------------------------- */

describe("history deleted while an action is confirmed", () => {
  it("lets the agent finish the call, then complete says not_found so it can drop the result", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const { action } = await newAction(chat);
    await chat.agent.agentPendingActions.confirm({ id: action.id });
    await chat.agent.agentHistory.delete();
    await expectApiError(chat.agent.agentPendingActions.complete({ id: action.id, status: "executed", result: {} }), "not_found", 404);
    await expectApiError(chat.agent.agentPendingActions.get({ id: action.id }), "not_found", 404);
  });
});

describe("history deletion that outlasts one transaction", () => {
  it("keeps what the user does after asking: new session, messages and actions survive, old ones go", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const { session: old, action: oldAction } = await newAction(chat);
    await t.run(async (ctx) => {
      for (let seq = 1; seq <= 700; seq++) {
        await ctx.db.insert("agentMessages", {
          sessionId: old.id as unknown as Id<"agentSessions">,
          userId: chat.userId,
          role: "user",
          content: "{}",
          seq,
          createdAt: Date.now(),
        });
      }
      await ctx.db.patch(old.id as unknown as Id<"agentSessions">, { messageCount: 700 });
    });

    // Set up above with real timers; from here the scheduled batches wait until the test runs them.
    vi.useFakeTimers();
    try {
      expect(await chat.agent.agentHistory.delete()).toEqual({ deleted: true });
      expect(await t.run((ctx) => ctx.db.query("agentMessages").collect())).not.toHaveLength(0); // batch 1 was not enough

      // The old session is marked for deletion: it takes nothing new and `current` starts a fresh one.
      await expectApiError(
        chat.agent.agentMessages.append({ sessionId: old.id, messages: [{ role: "user", content: json({ text: "late" }) }] }),
        "conflict",
        409,
      );
      await expectApiError(
        chat.agent.agentPendingActions.create({
          sessionId: old.id,
          operation: "transactions.create",
          input: expenseInput(chat.accountId!),
          summary: "late",
        }),
        "conflict",
        409,
      );
      vi.advanceTimersByTime(5_000);
      const fresh = await chat.agent.agentSessions.current({ channel: TG, chatId: chat.chatId, idleTimeoutMinutes: 30 });
      expect(fresh).toMatchObject({ created: true });
      expect(fresh.session.id).not.toBe(old.id);
      await chat.agent.agentMessages.append({ sessionId: fresh.session.id, messages: [{ role: "user", content: json({ text: "new" }) }] });
      const { action: newOne } = await chat.agent.agentPendingActions.create({
        sessionId: fresh.session.id,
        operation: "transactions.create",
        input: expenseInput(chat.accountId!),
        summary: "new",
      });

      await t.finishAllScheduledFunctions(vi.runAllTimers);

      await expectApiError(chat.agent.agentMessages.list({ sessionId: old.id }), "not_found", 404);
      await expectApiError(chat.agent.agentPendingActions.get({ id: oldAction.id }), "not_found", 404);
      expect((await chat.agent.agentMessages.list({ sessionId: fresh.session.id })).items.map((m) => JSON.parse(m.content).text)).toEqual(["new"]);
      expect((await chat.agent.agentPendingActions.get({ id: newOne.id })).action.status).toBe("pending");
      expect(await t.run((ctx) => ctx.db.query("agentSessions").collect())).toHaveLength(1);
      expect(await t.run((ctx) => ctx.db.query("agentMessages").collect())).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("history and unlink", () => {
  const counts = (t: T) =>
    t.run(async (ctx) => ({
      sessions: (await ctx.db.query("agentSessions").collect()).length,
      messages: (await ctx.db.query("agentMessages").collect()).length,
      actions: (await ctx.db.query("agentPendingActions").collect()).length,
    }));

  async function fill(chat: LinkedChat) {
    const { session: s } = await newAction(chat);
    await chat.agent.agentMessages.append({ sessionId: s.id, messages: [{ role: "user", content: json({ text: "hi" }) }] });
  }

  it("the service unlink route deletes that identity's history only", async () => {
    const t = setupApi();
    const { alice, bob } = await twoChats(t);
    await fill(alice);
    await fill(bob);
    await alice.service.channelIdentities.unlink({ channel: TG, externalUserId: alice.chat.externalUserId });
    expect(await counts(t)).toEqual({ sessions: 1, messages: 1, actions: 1 });
    const left = await t.run((ctx) => ctx.db.query("agentSessions").collect());
    expect(left[0]!.userId).toBe(bob.userId);
  });

  it("the web unlink deletes the identity's history", async () => {
    const t = setupApi();
    const { alice, bob } = await twoChats(t);
    await fill(alice);
    await fill(bob);
    await alice.web.mutation(api.channelLinks.unlink, { identityId: alice.identityId });
    expect(await counts(t)).toEqual({ sessions: 1, messages: 1, actions: 1 });
  });

  it("history does not come back after linking again", async () => {
    const t = setupApi();
    const alice = await linkedChat(t, { withAccount: true });
    await fill(alice);
    await alice.service.channelIdentities.unlink({ channel: TG, externalUserId: alice.chat.externalUserId });
    const { code } = await alice.web.action(api.channelLinks.createLinkCode, { channel: TG, consent: true });
    await alice.service.channelLinks.redeem({ ...alice.chat, code });
    const resolved = await alice.service.channelIdentities.resolve(alice.chat);
    expect(resolved.scopes).toContain("agent:state");
    expect(await counts(t)).toEqual({ sessions: 0, messages: 0, actions: 0 });
  });
});

/* -------------------------------------------------------------------------- */
/*  Contract conformance                                                      */
/* -------------------------------------------------------------------------- */

describe("contract conformance", () => {
  it("every agent route's success response parses with its contract schema", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const authed = (method: string, path: string, body?: unknown) =>
      raw(t, method, path, { token: chat.token, ...(body === undefined ? {} : { body }) });

    const claimed = await raw(t, "POST", "/agent/events/claim", { token: TEST_SERVICE_KEY, body: { channel: TG, eventId: "1", payload: "{}" } });
    expectConforms(routes.agentEvents.claim, claimed);
    expectConforms(
      routes.agentEvents.updateStatus,
      await raw(t, "POST", "/agent/events/status", { token: TEST_SERVICE_KEY, body: { channel: TG, eventId: "1", status: "processing" } }),
    );
    expectConforms(
      routes.agentEvents.listRecoverable,
      await raw(t, "GET", "/agent/events/recoverable?channel=telegram&olderThanSeconds=0", { token: TEST_SERVICE_KEY }),
    );

    const current = expectConforms(
      routes.agentSessions.current,
      await authed("POST", "/agent/sessions/current", { channel: TG, chatId: chat.chatId, idleTimeoutMinutes: 30 }),
    ) as { session: { id: string } };
    const sid = current.session.id;
    expectConforms(
      routes.agentMessages.append,
      await authed("POST", `/agent/sessions/${sid}/messages`, { messages: [{ role: "user", content: "{}" }] }),
    );
    expectConforms(routes.agentMessages.list, await authed("GET", `/agent/sessions/${sid}/messages?limit=10`));

    const created = expectConforms(
      routes.agentPendingActions.create,
      await authed("POST", "/agent/pending-actions", {
        sessionId: sid,
        operation: "transactions.create",
        input: expenseInput(chat.accountId!),
        summary: "Add expense",
      }),
    ) as { action: { id: string } };
    const id = created.action.id;
    expectConforms(routes.agentPendingActions.get, await authed("GET", `/agent/pending-actions/${id}`));
    expectConforms(routes.agentPendingActions.confirm, await authed("POST", `/agent/pending-actions/${id}/confirm`, {}));
    expectConforms(
      routes.agentPendingActions.complete,
      await authed("POST", `/agent/pending-actions/${id}/complete`, { status: "executed", result: { ok: true } }),
    );
    const other = (
      expectConforms(
        routes.agentPendingActions.create,
        await authed("POST", "/agent/pending-actions", {
          sessionId: sid,
          operation: "transactions.create",
          input: expenseInput(chat.accountId!),
          summary: "Add expense",
        }),
      ) as { action: { id: string } }
    ).action.id;
    expectConforms(routes.agentPendingActions.cancel, await authed("POST", `/agent/pending-actions/${other}/cancel`, {}));
    expectConforms(routes.agentHistory.delete, await authed("DELETE", "/agent/history"));
  });

  it("errors use the contract envelope with the right codes", async () => {
    const t = setupApi();
    const chat = await linkedChat(t);
    const codes: Array<[Promise<{ body: { error?: { code: ErrorCode } } }>, ErrorCode]> = [
      [raw(t, "GET", "/agent/pending-actions/missing", { token: chat.token }), "not_found"],
      [raw(t, "POST", "/agent/pending-actions/missing/confirm", { token: chat.token, body: {} }), "not_found"],
      [raw(t, "POST", "/agent/sessions/current", { token: chat.token, body: {} }), "validation_failed"],
    ];
    for (const [response, code] of codes) expect((await response).body.error?.code).toBe(code);
  });
});
