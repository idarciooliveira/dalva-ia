/**
 * The API for Playwright: recreates a throwaway database, migrates it, then serves.
 * Started by apps/web/playwright.config.ts; not for development (use `bun run dev:api`).
 *
 * PORT, PUBLIC_URL   where the API listens and the web origin in front of it
 * E2E_DATABASE_URL   database to recreate (name must start with dalva_e2e), default
 *                    postgres://dalva:dalva@127.0.0.1:5432/dalva_e2e_<PORT>, so runs on
 *                    different ports never drop each other's database
 *
 * Secrets are random per run. Bun also loads apps/api/.env.local here; nothing in it
 * but DATABASE_POOL_MAX and LOG_LEVEL survives.
 */
import { randomBytes } from "node:crypto";

import postgres from "postgres";

import { runMigrations } from "../src/db/migrate";

const port = process.env.PORT || "4000";
const url = new URL(process.env.E2E_DATABASE_URL || `postgres://dalva:dalva@127.0.0.1:5432/dalva_e2e_${port}`);
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
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  NODE_ENV: "test",
  PORT: port,
  PUBLIC_URL: process.env.PUBLIC_URL || "http://localhost:3000",
  BETTER_AUTH_SECRET: secret(),
  FINANCE_API_TOKEN_SECRET: secret(),
  FINANCE_API_SERVICE_KEY: secret(),
  LOG_LEVEL: process.env.LOG_LEVEL || "warn",
});
// Rate limits per client address would trip on the suite's many sign-ups.
delete process.env.CLIENT_IP_HEADER;
console.log(`e2e-server: ${name} migrated, API on :${process.env.PORT} for ${process.env.PUBLIC_URL}`);

await import("../src/main");
