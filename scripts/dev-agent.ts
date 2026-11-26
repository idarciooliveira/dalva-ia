#!/usr/bin/env bun
// `bun run dev:agent`: the agent against the local apps/api, once it answers. Env: the root .env,
// plus FINANCE_API_URL from the API's PORT. The agent keeps its own port (8080), since PORT is the API's.
import { rootEnv, root } from "./lib/api-env";

const dotenv = rootEnv();
const serviceKey = process.env.FINANCE_API_SERVICE_KEY || dotenv.FINANCE_API_SERVICE_KEY;
if (!serviceKey) {
  console.error("dev:agent: FINANCE_API_SERVICE_KEY is missing from .env. Run `bun run setup`, then restart dev:api");
  process.exit(1);
}

// Process env wins over the .env the agent loads.
const env: Record<string, string | undefined> = {
  ...process.env,
  FINANCE_API_URL: process.env.FINANCE_API_URL || `http://localhost:${process.env.PORT || dotenv.PORT || "4000"}`,
  FINANCE_API_SERVICE_KEY: serviceKey,
  PORT: "8080",
};
console.log(`dev:agent: using apps/api at ${env.FINANCE_API_URL}`);

const run = (cmd: string[]) => Bun.spawn(cmd, { cwd: root, env, stdio: ["inherit", "inherit", "inherit"] }).exited;

const waited = await run(["bun", "scripts/wait-for-finance-api.ts"]);
if (waited !== 0) process.exit(waited);
process.exit(await run(["bun", "run", "--filter", "@mpf/agent", "dev"]));
