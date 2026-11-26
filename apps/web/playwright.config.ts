import { randomBytes } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

import { E2E_BOT_USERNAME, E2E_OWNER } from "./e2e/helpers/stack";

/**
 * Playwright E2E test configuration for @mpf/web.
 *
 * Runs against the local stack: apps/api on a throwaway Postgres database
 * (recreated and migrated on start, see apps/api/scripts/e2e-server.ts) and the
 * web dev server, which proxies /api to it. Needs a Postgres server:
 * `docker compose -f compose.dev.yml up -d`, or E2E_DATABASE_URL.
 *
 * E2E_WEB_PORT / E2E_API_PORT (3000 / 4000) move both servers off ports in use
 * (`bun run dev` holds the defaults). Servers already listening are never reused:
 * the run would hit the dev database, or a proxy pointing at another API.
 *
 * The API gets a service key made here (`E2E_FINANCE_API_SERVICE_KEY`): the
 * workers inherit it and call the bot's service routes with it (settings.spec.ts).
 * It signs up the instance owner (`E2E_OWNER`) before serving and talks to a
 * Telegram stub, never to Telegram (apps/api/scripts/telegram-stub.ts).
 *
 * @see https://playwright.dev/docs/test-configuration
 */
const webPort = Number(process.env.E2E_WEB_PORT || 3000);
const apiPort = Number(process.env.E2E_API_PORT || 4000);
const webOrigin = `http://localhost:${webPort}`;
// Set once, in the runner: the workers load this file again and must keep the same key.
process.env.E2E_FINANCE_API_SERVICE_KEY ||= randomBytes(32).toString("hex");
process.env.E2E_API_URL ||= `http://127.0.0.1:${apiPort}`;
export default defineConfig({
  testDir: "./e2e",
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use */
  reporter: "html",

  /* Shared settings for all the projects below */
  use: {
    baseURL: webOrigin,
    /* Collect trace when retrying the failed test */
    trace: "on-first-retry",
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],

  /* Start the API (fresh database) and the web dev server before the tests */
  webServer: [
    {
      command: "bun --env-file=../../.env scripts/e2e-server.ts",
      cwd: "../api",
      url: `http://127.0.0.1:${apiPort}/health`,
      env: {
        PORT: String(apiPort),
        PUBLIC_URL: webOrigin,
        E2E_FINANCE_API_SERVICE_KEY: process.env.E2E_FINANCE_API_SERVICE_KEY,
        E2E_BOT_USERNAME,
        E2E_OWNER_EMAIL: E2E_OWNER.email,
        E2E_OWNER_PASSWORD: E2E_OWNER.password,
        ...(process.env.E2E_DATABASE_URL ? { E2E_DATABASE_URL: process.env.E2E_DATABASE_URL } : {}),
      },
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `bunx vite dev --port ${webPort} --strictPort`,
      url: webOrigin,
      env: { DALVA_API_URL: `http://127.0.0.1:${apiPort}` },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
