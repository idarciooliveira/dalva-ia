// Waits until FINANCE_API_URL answers (dev:agent sets it). Any HTTP response counts.
const TIMEOUT_MS = 90_000;

const url = process.env.FINANCE_API_URL;
if (!url) process.exit(0); // nothing to wait for; the agent reports the missing config itself

const deadline = Date.now() + TIMEOUT_MS;
let logged = false;
while (Date.now() < deadline) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    process.exit(0);
  } catch {
    if (!logged) console.log(`waiting for the Finance API at ${url}`);
    logged = true;
    await Bun.sleep(1_000);
  }
}
console.error(`Finance API at ${url} did not answer within ${TIMEOUT_MS / 1000}s`);
process.exit(1);
