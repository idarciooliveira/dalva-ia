import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E test configuration for @mpf/web.
 *
 * Runs against the local stack: apps/api on a throwaway Postgres database
 * (recreated and migrated on start, see apps/api/scripts/e2e-server.ts) and the
 * web dev server, which proxies /api to it. Needs a Postgres server:
 * `docker compose -f compose.dev.yml up -d`, or E2E_DATABASE_URL.
 *
 * E2E_WEB_PORT / E2E_API_PORT (3000 / 4000) move both servers off ports in use.
 * Outside CI, servers already listening there are reused as they are.
 *
 * @see https://playwright.dev/docs/test-configuration
 */
const webPort = Number(process.env.E2E_WEB_PORT || 3000);
const apiPort = Number(process.env.E2E_API_PORT || 4000);
const webOrigin = `http://localhost:${webPort}`;
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
      command: "bun scripts/e2e-server.ts",
      cwd: "../api",
      url: `http://127.0.0.1:${apiPort}/health`,
      env: {
        PORT: String(apiPort),
        PUBLIC_URL: webOrigin,
        ...(process.env.E2E_DATABASE_URL ? { E2E_DATABASE_URL: process.env.E2E_DATABASE_URL } : {}),
      },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `bunx vite dev --port ${webPort} --strictPort`,
      url: webOrigin,
      env: { DALVA_API_URL: `http://127.0.0.1:${apiPort}` },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
