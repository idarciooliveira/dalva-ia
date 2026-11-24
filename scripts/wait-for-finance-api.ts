import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const agentDir = join(import.meta.dir, "../apps/agent");
const TIMEOUT_MS = 90_000;

function fromEnvFile(file: string): string | undefined {
  const path = join(agentDir, file);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8").match(/^\s*FINANCE_API_URL\s*=\s*(\S+)/m)?.[1];
}

const url = process.env.FINANCE_API_URL || fromEnvFile(".env.local") || fromEnvFile(".env");
if (!url) process.exit(0); // nothing to wait for; the agent reports the missing config itself

const deadline = Date.now() + TIMEOUT_MS;
let logged = false;
while (Date.now() < deadline) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    process.exit(0); // any HTTP response means the backend is up
  } catch {
    if (!logged) console.log(`waiting for the Finance API at ${url}`);
    logged = true;
    await Bun.sleep(1_000);
  }
}
console.error(`Finance API at ${url} did not answer within ${TIMEOUT_MS / 1000}s`);
process.exit(1);
