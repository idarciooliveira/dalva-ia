/** Retention jobs: data rules, batching, the advisory lock and the scheduler. */
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { seedUser } from "../../test/api";
import { createDatabase } from "../db/client";
import { testDatabaseUrl, testDb } from "../../test/db";
import {
  agentInboundEvents,
  agentMessages,
  agentPendingActions,
  agentSessions,
  apiIdempotencyKeys,
  channelIdentities,
  channelLinkCodes,
} from "../db/schema";
import { withTx } from "../db/tx";
import {
  DAY_MS,
  EVENT_RETENTION_MS,
  expirePendingActions,
  HOUR_MS,
  purgeInactiveSessions,
  purgeStaleEvents,
  SESSION_RETENTION_MS,
} from "../domain/agentStore";
import { IDEMPOTENCY_TTL_MS } from "../http/idempotency";
import { createLogger } from "../log";
import { withAdvisoryLock } from "./lock";
import { RETENTION_JOBS, type RetentionJob, runJob, startRetentionJobs } from "./retention";

const TG = "telegram" as const;
const NOW = new Date(1_800_000_000_000);
const at = (ms: number) => new Date(NOW.getTime() + ms);

function job(name: string, batch?: number): RetentionJob {
  const found = RETENTION_JOBS.find((j) => j.name === name);
  if (!found) throw new Error(`no job ${name}`);
  return batch === undefined ? found : { ...found, batch };
}

async function seedIdentity(userId: string, externalUserId: string) {
  const [row] = await testDb()
    .insert(channelIdentities)
    .values({ userId, channel: TG, externalUserId, chatId: externalUserId, scopes: ["finance:read", "finance:write"], linkedAt: NOW, consentAt: NOW })
    .returning({ id: channelIdentities.id });
  return row!.id;
}

interface SeedOptions {
  lastActivityAt?: Date;
  messages?: number;
  actions?: Array<{ status?: "pending" | "confirmed" | "executed"; expiresAt?: Date; updatedAt?: Date }>;
}

async function seedSession(userId: string, identityId: string, options: SeedOptions = {}) {
  const lastActivityAt = options.lastActivityAt ?? NOW;
  const messages = options.messages ?? 0;
  const [session] = await testDb()
    .insert(agentSessions)
    .values({ userId, identityId, channel: TG, chatId: "c", startedAt: lastActivityAt, lastActivityAt, messageCount: messages })
    .returning({ id: agentSessions.id });
  const sessionId = session!.id;
  if (messages > 0) {
    await testDb()
      .insert(agentMessages)
      .values(Array.from({ length: messages }, (_, i) => ({ sessionId, userId, role: "user" as const, content: "{}", seq: i + 1 })));
  }
  for (const action of options.actions ?? [{}]) {
    await testDb()
      .insert(agentPendingActions)
      .values({
        userId,
        sessionId,
        operation: "transactions.create",
        input: "{}",
        summary: "x",
        status: action.status ?? "pending",
        expiresAt: action.expiresAt ?? at(HOUR_MS),
        createdAt: lastActivityAt,
        updatedAt: action.updatedAt ?? lastActivityAt,
      });
  }
  return sessionId;
}

const counts = async () => ({
  sessions: (await testDb().select().from(agentSessions)).length,
  messages: (await testDb().select().from(agentMessages)).length,
  actions: (await testDb().select().from(agentPendingActions)).length,
});

const seedEvent = (eventId: string, status: "received" | "processing" | "done" | "failed", updatedAt: Date) =>
  testDb()
    .insert(agentInboundEvents)
    .values({
      channel: TG,
      eventId,
      status,
      attempts: 1,
      payload: status === "done" || status === "failed" ? "" : '{"text":"secret"}',
      receivedAt: updatedAt,
      updatedAt,
    });

async function aliceWithIdentity() {
  const userId = await seedUser();
  return { userId, identity: await seedIdentity(userId, "1") };
}

describe("job: purge_agent_events", () => {
  it("deletes done and failed events 24h after their last update, and keeps newer ones", async () => {
    await seedEvent("old-done", "done", at(-EVENT_RETENTION_MS - 1));
    await seedEvent("old-failed", "failed", at(-EVENT_RETENTION_MS - 1));
    await seedEvent("new-done", "done", at(-EVENT_RETENTION_MS + HOUR_MS));
    await seedEvent("new-failed", "failed", at(-HOUR_MS));
    expect(await runJob(testDb(), job("purge_agent_events"), NOW)).toEqual({ status: "done", rows: 2 });
    const left = (await testDb().select().from(agentInboundEvents)).map((e) => e.eventId).sort();
    expect(left).toEqual(["new-done", "new-failed"]);
  });

  it("also drops events stuck unprocessed for 24h, since they hold message text", async () => {
    await seedEvent("stuck-received", "received", at(-2 * DAY_MS));
    await seedEvent("stuck-processing", "processing", at(-2 * DAY_MS));
    await seedEvent("recent-received", "received", at(-5 * 60_000));
    await runJob(testDb(), job("purge_agent_events"), NOW);
    expect((await testDb().select().from(agentInboundEvents)).map((e) => e.eventId)).toEqual(["recent-received"]);
  });

  it("works in batches until one comes back short", async () => {
    for (let i = 0; i < 7; i++) await seedEvent(`e${i}`, "done", at(-2 * DAY_MS));
    expect(await runJob(testDb(), job("purge_agent_events", 3), NOW)).toEqual({ status: "done", rows: 7 });
    expect(await testDb().select().from(agentInboundEvents)).toHaveLength(0);
  });
});

describe("job: expire_agent_actions", () => {
  it("marks pending actions past expiresAt as expired and leaves the rest alone", async () => {
    const { userId, identity } = await aliceWithIdentity();
    await seedSession(userId, identity, {
      actions: [
        { status: "pending", expiresAt: at(-1) },
        { status: "pending", expiresAt: at(HOUR_MS) },
        { status: "confirmed", expiresAt: at(-HOUR_MS) },
        { status: "executed", expiresAt: at(-HOUR_MS) },
      ],
    });
    expect(await runJob(testDb(), job("expire_agent_actions"), NOW)).toEqual({ status: "done", rows: 1 });
    const rows = await testDb().select().from(agentPendingActions).orderBy(agentPendingActions.id);
    expect(rows.map((a) => [a.status, a.expiresAt > NOW])).toEqual([
      ["expired", false],
      ["pending", true],
      ["confirmed", false],
      ["executed", false],
    ]);
    expect(rows[0]!.updatedAt).toEqual(NOW);
  });

  it("works through a backlog in batches", async () => {
    const { userId, identity } = await aliceWithIdentity();
    await seedSession(userId, identity, { actions: Array.from({ length: 5 }, () => ({ status: "pending" as const, expiresAt: at(-1) })) });
    expect(await runJob(testDb(), job("expire_agent_actions", 2), NOW)).toEqual({ status: "done", rows: 5 });
    expect((await testDb().select().from(agentPendingActions)).every((a) => a.status === "expired")).toBe(true);
  });
});

describe("job: purge_agent_history", () => {
  it("deletes sessions inactive for more than 30 days with their messages and actions", async () => {
    const { userId, identity } = await aliceWithIdentity();
    await seedSession(userId, identity, { lastActivityAt: at(-SESSION_RETENTION_MS - 1), messages: 4 });
    const fresh = await seedSession(userId, identity, { lastActivityAt: at(-SESSION_RETENTION_MS + DAY_MS), messages: 2 });

    await runJob(testDb(), job("purge_agent_history"), NOW);
    expect(await counts()).toEqual({ sessions: 1, messages: 2, actions: 1 });
    expect((await testDb().select().from(agentSessions))[0]!.id).toBe(fresh);
  });

  it("drops actions older than 30 days even when their session is still active", async () => {
    const { userId, identity } = await aliceWithIdentity();
    await seedSession(userId, identity, {
      actions: [
        { status: "executed", updatedAt: at(-SESSION_RETENTION_MS - 1) },
        { status: "executed", updatedAt: at(-DAY_MS) },
      ],
    });
    await runJob(testDb(), job("purge_agent_history"), NOW);
    expect(await counts()).toEqual({ sessions: 1, messages: 0, actions: 1 });
  });

  it("works through a backlog in batches", async () => {
    const { userId, identity } = await aliceWithIdentity();
    for (let i = 0; i < 7; i++) await seedSession(userId, identity, { lastActivityAt: at(-40 * DAY_MS), messages: 3 });
    await runJob(testDb(), job("purge_agent_history", 2), NOW);
    expect(await counts()).toEqual({ sessions: 0, messages: 0, actions: 0 });
  });
});

describe("job: purge_link_codes", () => {
  it("purges expired codes, used or not, and keeps live ones", async () => {
    const [alice, bob, carol] = [await seedUser(), await seedUser(), await seedUser()];
    const code = (userId: string, codeHash: string, expiresAt: Date, used = false) =>
      testDb()
        .insert(channelLinkCodes)
        .values({ userId, channel: TG, codeHash, expiresAt, consentAt: NOW, usedAt: used ? NOW : null });
    await code(alice, "used", at(-1), true);
    await code(bob, "unused", at(-1));
    await code(carol, "live", at(60_000));
    expect(await runJob(testDb(), job("purge_link_codes"), NOW)).toEqual({ status: "done", rows: 2 });
    expect((await testDb().select().from(channelLinkCodes)).map((c) => c.codeHash)).toEqual(["live"]);
  });

  it("works through more than one batch", async () => {
    const users = await Promise.all(Array.from({ length: 5 }, () => seedUser()));
    await testDb()
      .insert(channelLinkCodes)
      .values(users.map((userId, i) => ({ userId, channel: TG, codeHash: `hash-${i}`, expiresAt: at(-1), consentAt: NOW })));
    expect(await runJob(testDb(), job("purge_link_codes", 2), NOW)).toEqual({ status: "done", rows: 5 });
  });
});

describe("job: purge_idempotency_keys", () => {
  it("deletes keys older than the TTL in batches and keeps the rest", async () => {
    const userId = await seedUser();
    await testDb()
      .insert(apiIdempotencyKeys)
      .values([
        ...Array.from({ length: 5 }, (_, i) => ({ userId, key: `old-${i}`, requestHash: "h", createdAt: at(-IDEMPOTENCY_TTL_MS - 1) })),
        { userId, key: "fresh", requestHash: "h", createdAt: at(-DAY_MS) },
      ]);
    expect(await runJob(testDb(), job("purge_idempotency_keys", 2), NOW)).toEqual({ status: "done", rows: 5 });
    expect((await testDb().select().from(apiIdempotencyKeys)).map((k) => k.key)).toEqual(["fresh"]);
  });
});

describe("jobs racing requests", () => {
  /** Run `write` in a request transaction that stays open until the job below has queued behind it. */
  async function whileRequestHolds(write: Parameters<typeof withTx>[1], job: () => Promise<number>) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const holding = new Promise<void>((resolve) => (started = resolve));
    const request = withTx(
      testDb(),
      async (tx) => {
        await write(tx);
        started();
        await gate;
      },
      { maxAttempts: 1 },
    );
    await holding;
    const running = job();
    try {
      // Only release once the job's statement is waiting on the request's row lock.
      await expect
        .poll(async () => {
          const [row] = await testDb().execute<{ n: number }>(sql`
            select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()
          `);
          return row?.n;
        }, { timeout: 3_000, interval: 10 })
        .toBeGreaterThan(0);
    } finally {
      release();
    }
    await request;
    return await running;
  }

  it("leaves an old event alone that a request just moved to processing", async () => {
    await seedEvent("e1", "received", new Date(Date.now() - 2 * DAY_MS));
    const deleted = await whileRequestHolds(
      (tx) => tx.update(agentInboundEvents).set({ status: "processing", updatedAt: new Date() }).where(eq(agentInboundEvents.eventId, "e1")),
      () => purgeStaleEvents(testDb(), new Date(Date.now() - EVENT_RETENTION_MS), 10),
    );
    expect(deleted).toBe(0);
    expect(await testDb().select().from(agentInboundEvents)).toHaveLength(1);
  });

  it("leaves an old session alone that a request just wrote to", async () => {
    const { userId, identity } = await aliceWithIdentity();
    const sessionId = await seedSession(userId, identity, { lastActivityAt: new Date(Date.now() - 40 * DAY_MS) });
    const deleted = await whileRequestHolds(
      (tx) => tx.update(agentSessions).set({ lastActivityAt: new Date() }).where(eq(agentSessions.id, sessionId)),
      () => purgeInactiveSessions(testDb(), new Date(), 10),
    );
    expect(deleted).toBe(0);
    expect(await counts()).toEqual({ sessions: 1, messages: 0, actions: 1 });
  });

  it("doesn't expire an action a request is confirming", async () => {
    const { userId, identity } = await aliceWithIdentity();
    await seedSession(userId, identity, { actions: [{ status: "pending", expiresAt: new Date(Date.now() - 1) }] });
    const expired = await whileRequestHolds(
      (tx) => tx.update(agentPendingActions).set({ status: "confirmed", updatedAt: new Date() }),
      () => expirePendingActions(testDb(), new Date(), 10),
    );
    expect(expired).toBe(0);
    expect((await testDb().select().from(agentPendingActions))[0]!.status).toBe("confirmed");
  });
});

/** Advisory locks held in this worker's database (workers share the server). */
async function advisoryLocksHeld() {
  const [row] = await testDb().execute<{ n: number }>(sql`
    select count(*)::int as n from pg_locks
    where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = current_database())
  `);
  return row?.n;
}

describe("advisory lock", () => {
  it("skips a job another connection (another API instance) is running", async () => {
    await seedEvent("old", "done", at(-2 * DAY_MS));
    const other = createDatabase({ url: testDatabaseUrl(), max: 1 });
    try {
      const held = await withAdvisoryLock(other.db, "dalva:job:purge_agent_events", async () => {
        // The other instance holds it: this one skips, and deletes nothing.
        expect(await runJob(testDb(), job("purge_agent_events"), NOW)).toEqual({ status: "skipped" });
        expect(await testDb().select().from(agentInboundEvents)).toHaveLength(1);
        // Locks are per job: another job still runs.
        expect(await runJob(testDb(), job("purge_link_codes"), NOW)).toEqual({ status: "done", rows: 0 });
        return "held";
      });
      expect(held).toEqual({ ran: true, value: "held" });
      // Released: the job runs again.
      expect(await runJob(testDb(), job("purge_agent_events"), NOW)).toEqual({ status: "done", rows: 1 });
    } finally {
      await other.close();
    }
  });

  it("runs a job on a one-connection pool", async () => {
    await seedEvent("old", "done", at(-2 * DAY_MS));
    const tiny = createDatabase({ url: testDatabaseUrl(), max: 1 });
    try {
      expect(await runJob(tiny.db, job("purge_agent_events"), NOW)).toEqual({ status: "done", rows: 1 });
      // The connection went back to the pool unlocked (another session can take the lock).
      expect(await runJob(testDb(), job("purge_agent_events"), NOW)).toEqual({ status: "done", rows: 0 });
      expect(await advisoryLocksHeld()).toBe(0);
    } finally {
      await tiny.close();
    }
  });

  it("is released when the job fails", async () => {
    const failing: RetentionJob = { name: "failing", schedule: "* * * * *", batch: 1, steps: [() => Promise.reject(new Error("boom"))] };
    await expect(runJob(testDb(), failing)).rejects.toThrow("boom");
    expect(await advisoryLocksHeld()).toBe(0);
  });
});

describe("scheduler", () => {
  it("runs each job on its schedule, logs the outcome and waits for a running job on stop", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const logger = createLogger({ level: "info", write: (line) => lines.push(JSON.parse(line)) });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const slow: RetentionJob = {
      name: "test_job",
      schedule: "* * * * * *", // every second
      batch: 10,
      steps: [
        async () => {
          calls++;
          await gate;
          return 3;
        },
      ],
    };
    const scheduler = startRetentionJobs(testDb(), logger, [slow]);
    await expect.poll(() => calls, { timeout: 3_000 }).toBe(1);
    const stopped = scheduler.stop();
    let done = false;
    void stopped.then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(done).toBe(false); // waits for the run in progress
    release();
    await stopped;
    expect(calls).toBe(1); // `protect`: no second run while the first was going, and none after stop
    expect(lines).toContainEqual(expect.objectContaining({ msg: "job_done", job: "test_job", rows: 3 }));
  });

  it("stop interrupts a long job between batches", async () => {
    let batches = 0;
    const endless: RetentionJob = {
      name: "endless_job",
      schedule: "* * * * * *",
      batch: 1,
      steps: [
        async () => {
          batches++;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return 1; // always a full batch
        },
      ],
    };
    const scheduler = startRetentionJobs(testDb(), createLogger({ level: "error", write: () => {} }), [endless]);
    await expect.poll(() => batches, { timeout: 3_000 }).toBeGreaterThan(2);
    await scheduler.stop();
    const after = batches;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(batches).toBe(after);
    expect(await advisoryLocksHeld()).toBe(0);
  });

  it("schedules the five retention jobs on valid UTC patterns", () => {
    expect(RETENTION_JOBS.map((j) => j.name).sort()).toEqual([
      "expire_agent_actions",
      "purge_agent_events",
      "purge_agent_history",
      "purge_idempotency_keys",
      "purge_link_codes",
    ]);
    const scheduler = startRetentionJobs(testDb(), createLogger({ level: "error", write: () => {} }));
    return scheduler.stop();
  });
});
