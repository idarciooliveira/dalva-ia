#!/usr/bin/env bun
import { rootEnv, root } from "./lib/api-env";

const API_WAIT_MS = 90_000;

const dotenv = rootEnv();
const serviceKey = process.env.FINANCE_API_SERVICE_KEY || dotenv.FINANCE_API_SERVICE_KEY;
if (!serviceKey) {
  console.error("dev:agent: FINANCE_API_SERVICE_KEY is missing from .env. Run `bun run setup`, then restart dev:api");
  process.exit(1);
}

const apiUrl = process.env.FINANCE_API_URL || `http://localhost:${process.env.PORT || dotenv.PORT || "4000"}`;
// Process env wins over the .env the agent loads.
const env: Record<string, string | undefined> = {
  ...process.env,
  FINANCE_API_URL: apiUrl,
  FINANCE_API_SERVICE_KEY: serviceKey,
  PORT: "8080",
};
console.log(`dev:agent: using apps/api at ${apiUrl}`);

async function apiAnswers(): Promise<boolean> {
  const deadline = Date.now() + API_WAIT_MS;
  let logged = false;
  while (Date.now() < deadline) {
    try {
      await fetch(apiUrl, { signal: AbortSignal.timeout(2_000) });
      return true;
    } catch {
      if (!logged) console.log(`dev:agent: waiting for the API at ${apiUrl}`);
      logged = true;
      await Bun.sleep(1_000);
    }
  }
  return false;
}

if (!(await apiAnswers())) {
  console.error(`dev:agent: the API at ${apiUrl} did not answer within ${API_WAIT_MS / 1000}s`);
  process.exit(1);
}
const agent = Bun.spawn(["bun", "run", "--filter", "@mpf/agent", "dev"], { cwd: root, env, stdio: ["inherit", "inherit", "inherit"] });
process.exit(await agent.exited);
