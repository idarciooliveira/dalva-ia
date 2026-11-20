import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Real Postgres: one migrated template per run, one database per worker (see test/global-setup.ts).
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    hookTimeout: 30_000,
  },
});
