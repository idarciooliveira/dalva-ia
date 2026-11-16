import { createHash } from "node:crypto";
import { hostname } from "node:os";

import postgres from "postgres";

/** Every database the suite creates starts with this; nothing else is ever dropped. */
export const RUN_PREFIX = "dalva_test_";

/** Matches compose.dev.yml. */
const DEFAULT_TEST_SERVER_URL = "postgres://dalva:dalva@127.0.0.1:5432/dalva";

export function testServerUrl(): string {
  return process.env.TEST_DATABASE_URL || DEFAULT_TEST_SERVER_URL;
}

/** host:port only: the URL can carry a password. */
export function describeServer(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || "5432"}`;
}

/**
 * Run ids are `dalva_test_<host>_<pid>`. The host part keeps runs from other
 * machines or containers sharing one server apart: a pid is only meaningful
 * (and only checked for liveness) on its own host.
 */
export const HOST_ID = createHash("sha256").update(hostname()).digest("hex").slice(0, 8);

export function runId(pid = process.pid): string {
  return `${RUN_PREFIX}${HOST_ID}_${pid}`;
}

/** The pid of a database this host created, or null for another host's (or a foreign) name. */
export function ownPid(database: string): number | null {
  const match = new RegExp(`^${RUN_PREFIX}${HOST_ID}_(\\d+)_`).exec(database);
  return match ? Number(match[1]) : null;
}

export const templateName = (runId: string) => `${runId}_template`;
export const workerDatabaseName = (runId: string, workerId: string) => `${runId}_w${workerId}`;

export function databaseUrl(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** One connection for CREATE/DROP DATABASE. Fails fast when the server is down. */
export function adminClient(serverUrl: string) {
  return postgres(serverUrl, { max: 1, connect_timeout: 5, onnotice: () => {} });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, owned by someone else.
    return (error as { code?: string }).code === "EPERM";
  }
}
