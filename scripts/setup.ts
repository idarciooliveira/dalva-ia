#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { apiDir, apiEnv, ensurePostgres, migrate, root } from "./lib/api-env";

const apiEnvFile = join(apiDir, ".env.local");
const agentDir = join(root, "apps/agent");

const secret = () => randomBytes(32).toString("hex");
const GENERATED = ["BETTER_AUTH_SECRET", "FINANCE_API_SERVICE_KEY"] as const;

const created = !existsSync(apiEnvFile);
let text = created ? readFileSync(join(apiDir, ".env.example"), "utf8") : readFileSync(apiEnvFile, "utf8");
const current = created ? {} : apiEnv();
const generated: string[] = [];
for (const name of GENERATED) {
  const value = current[name as keyof typeof current];
  if (value && !value.includes("replace-with")) continue;
  const line = `${name}=${secret()}`;
  const pattern = new RegExp(`^#?\\s*${name}=.*$`, "m");
  text = pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
  generated.push(name);
}
if (created || generated.length > 0) {
  writeFileSync(apiEnvFile, text, { mode: 0o600 });
}
console.log(
  created
    ? `setup: created apps/api/.env.local (${generated.join(", ")} generated)`
    : generated.length > 0
      ? `setup: generated ${generated.join(", ")} in apps/api/.env.local`
      : "setup: apps/api/.env.local already complete",
);

const databaseUrl = apiEnv().DATABASE_URL;
if (!databaseUrl) {
  console.error("setup: DATABASE_URL is missing from apps/api/.env.local");
  process.exit(1);
}
await ensurePostgres(databaseUrl, "setup");
migrate("setup");
console.log("setup: database migrated");

const agentEnv = join(agentDir, ".env");
if (!existsSync(agentEnv)) {
  writeFileSync(agentEnv, readFileSync(join(agentDir, ".env.example"), "utf8"), { mode: 0o600 });
  console.log("setup: created apps/agent/.env from .env.example. Fill TELEGRAM_BOT_TOKEN and an LLM key to run the bot.");
}

console.log("\nDone. Start everything with: bun run dev");
