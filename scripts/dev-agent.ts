#!/usr/bin/env bun
// `bun run dev:agent`: start the Telegram agent once its Finance API answers.
//
// DALVA_BACKEND=convex (default): the agent's own env files (apps/agent/.env.local from `bun run setup`).
// DALVA_BACKEND=api: the local apps/api instead. FINANCE_API_URL and FINANCE_API_SERVICE_KEY come
// from apps/api/.env.local or .env (PORT, FINANCE_API_SERVICE_KEY), overriding the agent's env files.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

/** `KEY=value` lines, `export` allowed. Quoted values keep `#`; unquoted ones end at ` #`. */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(.*?))\s*(?:\s#.*)?$/);
    if (match) env[match[1]!] = match[2] ?? match[3] ?? match[4]!.replace(/^#.*$/, "");
  }
  return env;
}

const backend = process.env.DALVA_BACKEND ?? "convex";
if (backend !== "convex" && backend !== "api") {
  console.error(`dev:agent: DALVA_BACKEND must be convex or api, not "${backend}"`);
  process.exit(1);
}

const env: Record<string, string | undefined> = { ...process.env };
if (backend === "api") {
  // Same precedence as Bun's env loading for apps/api: .env.local over .env.
  const api = { ...readEnvFile(join(root, "apps/api/.env")), ...readEnvFile(join(root, "apps/api/.env.local")) };
  if (!api.FINANCE_API_SERVICE_KEY) {
    console.error("dev:agent: set FINANCE_API_SERVICE_KEY in apps/api/.env.local (openssl rand -hex 32), then restart dev:api");
    process.exit(1);
  }
  // Process env wins over the agent's .env files when Bun loads them.
  env.FINANCE_API_URL = `http://localhost:${api.PORT || "4000"}`;
  env.FINANCE_API_SERVICE_KEY = api.FINANCE_API_SERVICE_KEY;
  console.log(`dev:agent: using apps/api at ${env.FINANCE_API_URL}`);
}

const run = (cmd: string[]) => Bun.spawn(cmd, { cwd: root, env, stdio: ["inherit", "inherit", "inherit"] }).exited;

const waited = await run(["bun", "scripts/wait-for-finance-api.ts"]);
if (waited !== 0) process.exit(waited);
process.exit(await run(["bun", "run", "--filter", "@mpf/agent", "dev"]));
