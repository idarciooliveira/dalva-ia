/**
 * Runs once per `vitest` run, in the main process: checks Postgres is
 * reachable, builds a migrated template database, and drops it (and every
 * worker database cloned from it) at the end. Each worker clones its own
 * database from the template (test/setup.ts).
 *
 * Database names carry this host and process (`dalva_test_<host>_<pid>_*`), so
 * concurrent runs (watch mode next to a one-off run, another machine on the
 * same server) never share or drop each other's databases. Leftovers of runs
 * on this host whose process is gone are dropped here.
 */
import type { TestProject } from "vitest/node";

import { runMigrations } from "../src/db/migrate";
import { adminClient, describeServer, isProcessAlive, ownPid, RUN_PREFIX, runId as makeRunId, templateName, testServerUrl } from "./databases";

declare module "vitest" {
  export interface ProvidedContext {
    /** Admin connection URL of the test server. */
    testServerUrl: string;
    /** Prefix of this run's databases (`dalva_test_<host>_<pid>`). */
    testRunId: string;
  }
}

export default async function setup(project: TestProject) {
  const serverUrl = testServerUrl();
  const runId = makeRunId();
  const admin = adminClient(serverUrl);

  try {
    await admin`select 1`;
  } catch (error) {
    await admin.end({ timeout: 1 }).catch(() => {});
    const reason = (error as { code?: string }).code ?? (error as Error).name;
    throw new Error(
      `Postgres is not reachable at ${describeServer(serverUrl)} (${reason}). ` +
        "Start it with `docker compose -f compose.dev.yml up -d` from the repo root, " +
        "or point TEST_DATABASE_URL at a server where the tests may create databases.",
    );
  }

  try {
    await dropDatabases(admin, (name) => {
      const pid = ownPid(name);
      return pid !== null && (pid === process.pid || !isProcessAlive(pid));
    });

    const template = templateName(runId);
    await admin.unsafe(`create database "${template}"`);
    const templateUrl = new URL(serverUrl);
    templateUrl.pathname = `/${template}`;
    // Closed before workers clone it: CREATE DATABASE ... TEMPLATE refuses a template with open connections.
    await runMigrations(templateUrl.toString());
  } finally {
    await admin.end({ timeout: 5 });
  }

  project.provide("testServerUrl", serverUrl);
  project.provide("testRunId", runId);

  return async () => {
    const cleanup = adminClient(serverUrl);
    try {
      await dropDatabases(cleanup, (name) => name.startsWith(`${runId}_`));
    } finally {
      await cleanup.end({ timeout: 5 });
    }
  };
}

async function dropDatabases(admin: ReturnType<typeof adminClient>, shouldDrop: (name: string) => boolean) {
  const rows = await admin<{ datname: string }[]>`
    select datname from pg_database where datname like ${`${RUN_PREFIX}%`}
  `;
  for (const { datname } of rows) {
    if (!shouldDrop(datname)) continue;
    await admin.unsafe(`drop database if exists "${datname}" with (force)`);
  }
}
