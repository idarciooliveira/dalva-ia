#!/usr/bin/env bun
// `bun run dev:agent`: start the Telegram agent once its Finance API answers.
//
// DALVA_BACKEND=api (default): the local apps/api. FINANCE_API_URL and FINANCE_API_SERVICE_KEY come
// from apps/api/.env.local or .env (PORT, FINANCE_API_SERVICE_KEY), overriding the agent's env files.
// DALVA_BACKEND=convex: the agent's own env files (FINANCE_API_URL pointing at a Convex deployment).
import { apiEnv, root } from "./lib/api-env";

const backend = process.env.DALVA_BACKEND ?? "api";
if (backend !== "convex" && backend !== "api") {
  console.error(`dev:agent: DALVA_BACKEND must be convex or api, not "${backend}"`);
  process.exit(1);
}

const env: Record<string, string | undefined> = { ...process.env };
if (backend === "api") {
  const api = apiEnv();
  if (!api.FINANCE_API_SERVICE_KEY) {
    console.error("dev:agent: FINANCE_API_SERVICE_KEY is missing from apps/api/.env.local. Run `bun run setup`, then restart dev:api");
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
