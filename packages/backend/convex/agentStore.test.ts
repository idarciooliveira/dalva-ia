import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { EVENT_RETENTION_MS, SESSION_RETENTION_MS } from "./domain/agentStore";
import { setupTest } from "./test.setup";

type T = ReturnType<typeof setupTest>;
const TG = "telegram" as const;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

async function newUser(t: T) {
  const userId = (await t.run((ctx) => ctx.db.insert("users", {}))) as string;
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

async function seedIdentity(t: T, userId: string, externalUserId: string) {
  return await t.run((ctx) =>
    ctx.db.insert("channelIdentities", {
      userId,
      channel: TG,
      externalUserId,
      chatId: externalUserId,
      scopes: ["finance:read", "finance:write"],
      linkedAt: NOW,
      consentAt: NOW,
    }),
  );
}

interface SeedOptions {
  lastActivityAt?: number;
  messages?: number;
  actions?: Array<{ status?: "pending" | "confirmed" | "executed"; expiresAt?: number; updatedAt?: number }>;
}

async function seedSession(t: T, userId: string, identityId: Id<"channelIdentities">, options: SeedOptions = {}) {
  return await t.run(async (ctx) => {
    const lastActivityAt = options.lastActivityAt ?? NOW;
    const messages = options.messages ?? 0;
    const sessionId = await ctx.db.insert("agentSessions", {
      userId,
      identityId,
      channel: TG,
      chatId: "c",
      startedAt: lastActivityAt,
      lastActivityAt,
      messageCount: messages,
    });
    for (let seq = 1; seq <= messages; seq++) {
      await ctx.db.insert("agentMessages", { sessionId, userId, role: "user", content: "{}", seq, createdAt: lastActivityAt });
    }
    for (const action of options.actions ?? [{}]) {
      await ctx.db.insert("agentPendingActions", {
        userId,
        sessionId,
        operation: "transactions.create",
        input: "{}",
        summary: "x",
        status: action.status ?? "pending",
        expiresAt: action.expiresAt ?? NOW + HOUR,
        createdAt: lastActivityAt,
        updatedAt: action.updatedAt ?? lastActivityAt,
      });
    }
    return sessionId;
  });
}

const counts = (t: T) =>
  t.run(async (ctx) => ({
    sessions: (await ctx.db.query("agentSessions").collect()).length,
    messages: (await ctx.db.query("agentMessages").collect()).length,
    actions: (await ctx.db.query("agentPendingActions").collect()).length,
  }));

const seedEvent = (t: T, eventId: string, status: "received" | "processing" | "done" | "failed", updatedAt: number) =>
  t.run((ctx) =>
    ctx.db.insert("agentInboundEvents", {
      channel: TG,
      eventId,
      status,
      attempts: 1,
      payload: status === "done" || status === "failed" ? "" : '{"text":"secret"}',
      receivedAt: updatedAt,
      updatedAt,
    }),
  );

// Scheduled continuations must not run in the background while a test inspects the data.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const scheduled = (t: T) => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());

describe("agentStore.deleteMyHistory (web)", () => {
  it("requires authentication", async () => {
    const t = setupTest();
    await expect(t.mutation(api.agentStore.deleteMyHistory, {})).rejects.toThrow("Not authenticated");
  });

  it("deletes the signed-in user's history across identities and leaves other users alone", async () => {
    const t = setupTest();
    const alice = await newUser(t);
    const bob = await newUser(t);
    const aliceIdentity = await seedIdentity(t, alice.userId, "1");
    const bobIdentity = await seedIdentity(t, bob.userId, "2");
    await seedSession(t, alice.userId, aliceIdentity, { messages: 3 });
    await seedSession(t, alice.userId, aliceIdentity, { messages: 2 });
    await seedSession(t, bob.userId, bobIdentity, { messages: 4 });

    await alice.as.mutation(api.agentStore.deleteMyHistory, {});
    expect(await counts(t)).toEqual({ sessions: 1, messages: 4, actions: 1 });
    const left = await t.run((ctx) => ctx.db.query("agentSessions").collect());
    expect(left[0]!.userId).toBe(bob.userId);
  });

  it("also removes actions whose session row is already gone", async () => {
    const t = setupTest();
    const alice = await newUser(t);
    const identity = await seedIdentity(t, alice.userId, "1");
    const sessionId = await seedSession(t, alice.userId, identity);
    await t.run((ctx) => ctx.db.delete(sessionId));
    await alice.as.mutation(api.agentStore.deleteMyHistory, {});
    expect(await counts(t)).toEqual({ sessions: 0, messages: 0, actions: 0 });
  });

  it("deletes in bounded batches and schedules the rest", async () => {
    const t = setupTest();
    const alice = await newUser(t);
    const identity = await seedIdentity(t, alice.userId, "1");
    for (let i = 0; i < 4; i++) await seedSession(t, alice.userId, identity, { messages: 5 });

    // 4 sessions x (5 messages + 1 action + 1 session) = 28 rows; budget 10 leaves most of them.
    await t.mutation(internal.agentStore.purgeUserHistory, { userId: alice.userId, budget: 10 });
    const after = await counts(t);
    expect(after.messages + after.actions + after.sessions).toBeGreaterThan(0);
    expect(after.messages + after.actions + after.sessions).toBeLessThanOrEqual(28 - 10);
    expect((await scheduled(t)).length).toBe(1);

    for (let i = 0; i < 10; i++) await t.mutation(internal.agentStore.purgeUserHistory, { userId: alice.userId, budget: 10 });
    expect(await counts(t)).toEqual({ sessions: 0, messages: 0, actions: 0 });
  });
});

describe("agentStore.purgeIdentityHistory", () => {
  it("deletes only that identity's sessions with their messages and actions", async () => {
    const t = setupTest();
    const alice = await newUser(t);
    const first = await seedIdentity(t, alice.userId, "1");
    const second = await seedIdentity(t, alice.userId, "2");
    await seedSession(t, alice.userId, first, { messages: 3 });
    await seedSession(t, alice.userId, second, { messages: 2 });
    await t.mutation(internal.agentStore.purgeIdentityHistory, { identityId: first });
    expect(await counts(t)).toEqual({ sessions: 1, messages: 2, actions: 1 });
    expect((await t.run((ctx) => ctx.db.query("agentSessions").collect()))[0]!.identityId).toBe(second);
  });

  it("continues past its budget through the scheduler", async () => {
    const t = setupTest();
    const alice = await newUser(t);
    const identity = await seedIdentity(t, alice.userId, "1");
    for (let i = 0; i < 3; i++) await seedSession(t, alice.userId, identity, { messages: 6 });
    await t.mutation(internal.agentStore.purgeIdentityHistory, { identityId: identity, budget: 8 });
    expect((await counts(t)).messages).toBeGreaterThan(0);
    expect((await scheduled(t)).length).toBe(1);
    for (let i = 0; i < 10; i++) await t.mutation(internal.agentStore.purgeIdentityHistory, { identityId: identity, budget: 8 });
    expect(await counts(t)).toEqual({ sessions: 0, messages: 0, actions: 0 });
  });
});

describe("cron: purgeInboundEvents", () => {
  it("deletes done and failed events 24h after their last update, and keeps newer ones", async () => {
    const t = setupTest();
    await seedEvent(t, "old-done", "done", NOW - EVENT_RETENTION_MS - 1);
    await seedEvent(t, "old-failed", "failed", NOW - EVENT_RETENTION_MS - 1);
    await seedEvent(t, "new-done", "done", NOW - EVENT_RETENTION_MS + HOUR);
    await seedEvent(t, "new-failed", "failed", NOW - HOUR);
    const deleted = await t.mutation(internal.agentStore.purgeInboundEvents, { now: NOW });
    expect(deleted).toBe(2);
    const left = (await t.run((ctx) => ctx.db.query("agentInboundEvents").collect())).map((e) => e.eventId).sort();
    expect(left).toEqual(["new-done", "new-failed"]);
  });

  it("also drops events stuck unprocessed for 24h, since they hold message text", async () => {
    const t = setupTest();
    await seedEvent(t, "stuck-received", "received", NOW - 2 * DAY);
    await seedEvent(t, "stuck-processing", "processing", NOW - 2 * DAY);
    await seedEvent(t, "recent-received", "received", NOW - 5 * 60_000);
    await t.mutation(internal.agentStore.purgeInboundEvents, { now: NOW });
    const left = (await t.run((ctx) => ctx.db.query("agentInboundEvents").collect())).map((e) => e.eventId);
    expect(left).toEqual(["recent-received"]);
  });

  it("is bounded: a full batch reschedules itself", async () => {
    const t = setupTest();
    for (let i = 0; i < 5; i++) await seedEvent(t, `e${i}`, "done", NOW - 2 * DAY);
    expect(await t.mutation(internal.agentStore.purgeInboundEvents, { now: NOW, batch: 3 })).toBe(3);
    expect((await scheduled(t)).length).toBe(1);
    expect(await t.mutation(internal.agentStore.purgeInboundEvents, { now: NOW, batch: 3 })).toBe(2);
    expect((await scheduled(t)).length).toBe(1);
    expect(await t.run((ctx) => ctx.db.query("agentInboundEvents").collect())).toHaveLength(0);
  });
});

describe("cron: expirePendingActions", () => {
  it("marks pending actions past expiresAt as expired and leaves the rest alone", async () => {
    const t = setupTest();
    const alice = await newUser(t);
    const identity = await seedIdentity(t, alice.userId, "1");
    await seedSession(t, alice.userId, identity, {
      actions: [
        { status: "pending", expiresAt: NOW - 1 },
        { status: "pending", expiresAt: NOW + HOUR },
        { status: "confirmed", expiresAt: NOW - HOUR },
        { status: "executed", expiresAt: NOW - HOUR },
      ],
    });
    expect(await t.mutation(internal.agentStore.expirePendingActions, { now: NOW })).toBe(1);
    const rows = await t.run((ctx) => ctx.db.query("agentPendingActions").collect());
    expect(rows.map((a) => [a.status, a.expiresAt > NOW])).toEqual([
      ["expired", false],
      ["pending", true],
      ["confirmed", false],
      ["executed", false],
    ]);
    expect(rows[0]!.updatedAt).toBe(NOW);
  });

  it("is bounded and reschedules while batches are full", async () => {
    const t = setupTest();
    const alice = await newUser(t);
    const identity = await seedIdentity(t, alice.userId, "1");
    await seedSession(t, alice.userId, identity, { actions: Array.from({ length: 5 }, () => ({ status: "pending" as const, expiresAt: NOW - 1 })) });
    expect(await t.mutation(internal.agentStore.expirePendingActions, { now: NOW, batch: 2 })).toBe(2);
    expect((await scheduled(t)).length).toBe(1);
    expect(await t.mutation(internal.agentStore.expirePendingActions, { now: NOW, batch: 10 })).toBe(3);
  });
});

describe("cron: purgeInactiveHistory", () => {
  it("deletes sessions inactive for more than 30 days with their messages and actions", async () => {
    const t = setupTest();
    const alice = await newUser(t);
    const identity = await seedIdentity(t, alice.userId, "1");
    await seedSession(t, alice.userId, identity, { lastActivityAt: NOW - SESSION_RETENTION_MS - 1, messages: 4 });
    const fresh = await seedSession(t, alice.userId, identity, { lastActivityAt: NOW - SESSION_RETENTION_MS + DAY, messages: 2 });

    await t.mutation(internal.agentStore.purgeInactiveHistory, { now: NOW });
    expect(await counts(t)).toEqual({ sessions: 1, messages: 2, actions: 1 });
    expect((await t.run((ctx) => ctx.db.query("agentSessions").collect()))[0]!._id).toBe(fresh);
  });

  it("drops finished actions older than 30 days even when their session is still active", async () => {
    const t = setupTest();
    const alice = await newUser(t);
    const identity = await seedIdentity(t, alice.userId, "1");
    await seedSession(t, alice.userId, identity, {
      actions: [
        { status: "executed", updatedAt: NOW - SESSION_RETENTION_MS - 1 },
        { status: "executed", updatedAt: NOW - DAY },
      ],
    });
    await t.mutation(internal.agentStore.purgeInactiveHistory, { now: NOW });
    expect(await counts(t)).toEqual({ sessions: 1, messages: 0, actions: 1 });
  });

  it("is bounded: with a small batch it works through the backlog over several runs", async () => {
    const t = setupTest();
    const alice = await newUser(t);
    const identity = await seedIdentity(t, alice.userId, "1");
    for (let i = 0; i < 4; i++) {
      await seedSession(t, alice.userId, identity, { lastActivityAt: NOW - 40 * DAY, messages: 3 });
    }
    await t.mutation(internal.agentStore.purgeInactiveHistory, { now: NOW, batch: 6 });
    const partial = await counts(t);
    expect(partial.sessions).toBeGreaterThan(0);
    expect(partial.sessions).toBeLessThan(4);
    expect((await scheduled(t)).length).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) await t.mutation(internal.agentStore.purgeInactiveHistory, { now: NOW, batch: 6 });
    expect(await counts(t)).toEqual({ sessions: 0, messages: 0, actions: 0 });
  });
});

describe("unlink with a large history", () => {
  it("deletes the first batch in the unlink mutation and the rest through the scheduler", async () => {
    const t = setupTest();
    const alice = await newUser(t);
    const bob = await newUser(t);
    const aliceIdentity = await seedIdentity(t, alice.userId, "1");
    const bobIdentity = await seedIdentity(t, bob.userId, "2");
    await seedSession(t, alice.userId, aliceIdentity, { messages: 700 });
    await seedSession(t, bob.userId, bobIdentity, { messages: 3 });

    await alice.as.mutation(api.channelLinks.unlink, { identityId: aliceIdentity });
    const first = await counts(t);
    expect(first.messages).toBeGreaterThan(3); // some of Alice's are left for the continuation
    expect(first.messages).toBeLessThan(703);
    expect((await scheduled(t)).length).toBe(1);

    await t.mutation(internal.agentStore.purgeIdentityHistory, { identityId: aliceIdentity });
    expect(await counts(t)).toEqual({ sessions: 1, messages: 3, actions: 1 });
    const left = await t.run((ctx) => ctx.db.query("agentSessions").collect());
    expect(left[0]!.userId).toBe(bob.userId);
  });
});
