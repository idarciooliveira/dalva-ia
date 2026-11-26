#!/usr/bin/env bun
// `bun run dev:api`: Postgres up (compose.dev.yml unless something already listens),
// migrations applied, then apps/api in watch mode on PORT (4000). Env: the root .env.
import { existsSync } from "node:fs";

import { apiDir, envFile, ensurePostgres, migrate, rootEnv } from "./lib/api-env";

if (!existsSync(envFile)) {
  console.error("dev:api: .env is missing. Run `bun run setup` first.");
  process.exit(1);
}
const env = rootEnv();
if (!env.DATABASE_URL) {
  console.error("dev:api: DATABASE_URL is missing from .env. Run `bun run setup`.");
  process.exit(1);
}

await ensurePostgres(env.DATABASE_URL, "dev:api");
migrate("dev:api");
const api = Bun.spawn(["bun", "run", "dev"], { cwd: apiDir, stdio: ["inherit", "inherit", "inherit"] });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => api.kill(signal));
process.exit(await api.exited);
