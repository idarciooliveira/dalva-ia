import { Cron } from "croner";

import type { Database } from "../db/client";
import { expirePendingActions, EVENT_RETENTION_MS, purgeInactiveSessions, purgeStaleActions, purgeStaleEvents } from "../domain/agentStore";
import { purgeExpiredCodes } from "../domain/channelLinks";
import { purgeExpiredIdempotencyKeys } from "../http/idempotency";
import { errorFields, type Logger } from "../log";
import { withAdvisoryLock } from "./lock";

type Step = (db: Database, now: Date, batch: number) => Promise<number>;

export interface RetentionJob {
  name: string;
  schedule: string;
  batch: number;
  steps: Step[];
}

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
    batch: 50,
    steps: [purgeInactiveSessions, purgeStaleActions],
  },
];

export type JobResult = { status: "done"; rows: number } | { status: "skipped" };

export async function runJob(db: Database, job: RetentionJob, now = new Date(), signal?: AbortSignal): Promise<JobResult> {
  const result = await withAdvisoryLock(db, `dalva:job:${job.name}`, async (lockedDb) => {
    let rows = 0;
    for (const step of job.steps) {
      for (let batches = 0; batches < MAX_BATCHES_PER_STEP; batches++) {
        if (signal?.aborted) return rows;
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
  stop(): Promise<void>;
}

export function startRetentionJobs(db: Database, logger: Logger, jobs: RetentionJob[] = RETENTION_JOBS): JobScheduler {
  const running = new Set<Promise<unknown>>();
  const stopping = new AbortController();
  const crons = jobs.map(
    (job) =>
      new Cron(job.schedule, { name: job.name, timezone: "UTC", protect: true }, async () => {
        const started = Date.now();
        const run = runJob(db, job, new Date(), stopping.signal).then(
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
      stopping.abort();
      await Promise.all(running);
    },
  };
}
