import { randomBytes } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

import { E2E_BOT_USERNAME, E2E_OWNER } from "./e2e/helpers/stack";

const webPort = Number(process.env.E2E_WEB_PORT || 3000);
const apiPort = Number(process.env.E2E_API_PORT || 4000);
const webOrigin = `http://localhost:${webPort}`;
// Set once, in the runner: the workers load this file again and must keep the same key.
process.env.E2E_FINANCE_API_SERVICE_KEY ||= randomBytes(32).toString("hex");
process.env.E2E_API_URL ||= `http://127.0.0.1:${apiPort}`;
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",

  use: {
    baseURL: webOrigin,
    trace: "on-first-retry",
  },

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
