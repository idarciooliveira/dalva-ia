/**
 * The API for Playwright: recreates a throwaway database, migrates it, then serves.
 * Started by apps/web/playwright.config.ts; not for development (use `bun run dev:api`).
 *
 * E2E_DATABASE_URL   database to recreate (name must start with dalva_e2e), default
 *                    postgres://dalva:dalva@127.0.0.1:5432/dalva_e2e
 * PORT, PUBLIC_URL   where the API listens and the web origin in front of it
 * Secrets are random per run unless set.
 */
import { randomBytes } from "node:crypto";

import postgres from "postgres";

import { runMigrations } from "../src/db/migrate";

const url = new URL(process.env.E2E_DATABASE_URL || "postgres://dalva:dalva@127.0.0.1:5432/dalva_e2e");
const name = decodeURIComponent(url.pathname.slice(1));
// It gets dropped: never let this point at a database that matters.
if (!/^dalva_e2e\w*$/.test(name)) {
  console.error(`e2e-server: refusing to recreate "${name}"; the database name must start with dalva_e2e`);
  process.exit(1);
}

const maintenance = new URL(url);
maintenance.pathname = "/postgres";
const admin = postgres(maintenance.toString(), { max: 1, onnotice: () => {} });
try {
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${name}"`);
} finally {
  await admin.end();
}
await runMigrations(url.toString());

const secret = () => randomBytes(32).toString("hex");
process.env.DATABASE_URL = url.toString();
process.env.NODE_ENV ||= "test";
process.env.PORT ||= "4000";
process.env.PUBLIC_URL ||= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ||= secret();
process.env.FINANCE_API_TOKEN_SECRET ||= secret();
process.env.FINANCE_API_SERVICE_KEY ||= secret();
process.env.LOG_LEVEL ||= "warn";
console.log(`e2e-server: ${name} migrated, API on :${process.env.PORT} for ${process.env.PUBLIC_URL}`);

await import("../src/main");
