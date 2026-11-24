#!/usr/bin/env bun
import { apiEnv, root } from "./lib/api-env";

const api = apiEnv();
if (!api.FINANCE_API_SERVICE_KEY) {
  console.error("dev:agent: FINANCE_API_SERVICE_KEY is missing from apps/api/.env.local. Run `bun run setup`, then restart dev:api");
  process.exit(1);
}

// Process env wins over the agent's .env files when Bun loads them.
const env: Record<string, string | undefined> = {
  ...process.env,
  FINANCE_API_URL: `http://localhost:${api.PORT || "4000"}`,
  FINANCE_API_SERVICE_KEY: api.FINANCE_API_SERVICE_KEY,
};
console.log(`dev:agent: using apps/api at ${env.FINANCE_API_URL}`);

const run = (cmd: string[]) => Bun.spawn(cmd, { cwd: root, env, stdio: ["inherit", "inherit", "inherit"] }).exited;

const waited = await run(["bun", "scripts/wait-for-finance-api.ts"]);
if (waited !== 0) process.exit(waited);
process.exit(await run(["bun", "run", "--filter", "@mpf/agent", "dev"]));
