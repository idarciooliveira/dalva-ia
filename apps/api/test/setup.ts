/**
 * Per test file: make sure this worker's database exists (cloned from the
 * migrated template on first use), connect, and empty every table before each
 * test. Tests in a file run one after another, and each worker has its own
 * database, so tests never see each other's rows.
 */
import { afterAll, beforeAll, beforeEach, inject } from "vitest";

import { connectTestDatabase, disconnectTestDatabase, truncateAll } from "./db";

beforeAll(async () => {
  await connectTestDatabase(inject("testServerUrl"), inject("testRunId"));
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await disconnectTestDatabase();
});
