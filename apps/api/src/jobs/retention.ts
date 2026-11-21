/**
 * Retention jobs, in-process (croner). The Convex crons
 * (`packages/backend/convex/crons.ts`), same data and cadence:
 * - idempotency keys older than 7 days, daily
 * - expired channel link codes (used or not), hourly
 * - inbound agent events 24h after their last update (they hold message text), hourly
 * - pending actions past `expiresAt` become `expired`, every 15 minutes
 * - agent sessions inactive for 30 days (with messages and actions), and
 *   actions of that age, daily
 *
 * Each step deletes or updates one batch per statement and repeats until a
 * batch comes back short. A job runs on one connection that holds a Postgres
 * advisory lock, so two API instances never run the same job at once; one
 * that finds it locked skips that run.
 */
import { Cron } from "croner";

import type { Database } from "../db/client";
import { expirePendingActions, EVENT_RETENTION_MS, purgeInactiveSessions, purgeStaleActions, purgeStaleEvents } from "../domain/agentStore";
import { purgeExpiredCodes } from "../domain/channelLinks";
import { purgeExpiredIdempotencyKeys } from "../http/idempotency";
import { errorFields, type Logger } from "../log";
import { withAdvisoryLock } from "./lock";

/** One batch: rows deleted or updated (fewer than `batch` means done). */
type Step = (db: Database, now: Date, batch: number) => Promise<number>;

export interface RetentionJob {
  name: string;
  /** Cron pattern, UTC. */
  schedule: string;
  batch: number;
  steps: Step[];
}

/** A step that keeps coming back full after this many batches is stopped until the next run. */
const MAX_BATCHES_PER_STEP = 1_000;

export const RETENTION_JOBS: RetentionJob[] = [
  {
    name: "purge_idempotency_keys",
    schedule: "17 3 * * *",
    batch: 500,
    steps: [(db, now, batch) => purgeExpiredIdempotencyKeys(db, { now: now.getTime(), batch })],
  },
  {
    name: "purge_link_codes",
    schedule: "7 * * * *",
    batch: 500,
    steps: [purgeExpiredCodes],
  },
  {
    name: "purge_agent_events",
    schedule: "27 * * * *",
    batch: 200,
    steps: [(db, now, batch) => purgeStaleEvents(db, new Date(now.getTime() - EVENT_RETENTION_MS), batch)],
  },
  {
    name: "expire_agent_actions",
    schedule: "*/15 * * * *",
    batch: 200,
    steps: [expirePendingActions],
  },
  {
    name: "purge_agent_history",
    schedule: "47 3 * * *",
    // Sessions cascade to up to 500 messages each: keep the session batch small.
    batch: 50,
    steps: [purgeInactiveSessions, purgeStaleActions],
  },
];

export type JobResult = { status: "done"; rows: number } | { status: "skipped" };

/** Run one job now: every step until a batch comes back short, under the job's advisory lock. */
export async function runJob(db: Database, job: RetentionJob, now = new Date()): Promise<JobResult> {
  const result = await withAdvisoryLock(db, `dalva:job:${job.name}`, async (lockedDb) => {
    let rows = 0;
    for (const step of job.steps) {
      for (let batches = 0; batches < MAX_BATCHES_PER_STEP; batches++) {
        const n = await step(lockedDb, now, job.batch);
        rows += n;
        if (n < job.batch) break;
      }
    }
    return rows;
  });
  return result.ran ? { status: "done", rows: result.value } : { status: "skipped" };
}

export interface JobScheduler {
  /** Stop scheduling and wait for runs in progress. */
  stop(): Promise<void>;
}

/** Schedule `jobs` (default: all). A run still going when its next one is due is not doubled (`protect`). */
export function startRetentionJobs(db: Database, logger: Logger, jobs: RetentionJob[] = RETENTION_JOBS): JobScheduler {
  const running = new Set<Promise<unknown>>();
  const crons = jobs.map(
    (job) =>
      new Cron(job.schedule, { name: job.name, timezone: "UTC", protect: true }, async () => {
        const started = Date.now();
        const run = runJob(db, job).then(
          (result) =>
            result.status === "done"
              ? logger.info("job_done", { job: job.name, rows: result.rows, ms: Date.now() - started })
              : logger.info("job_skipped", { job: job.name, reason: "locked" }),
          (error: unknown) => logger.error("job_failed", { job: job.name, ...errorFields(error) }),
        );
        running.add(run);
        try {
          await run;
        } finally {
          running.delete(run);
        }
      }),
  );
  return {
    async stop() {
      for (const cron of crons) cron.stop();
      await Promise.all(running);
    },
  };
}
