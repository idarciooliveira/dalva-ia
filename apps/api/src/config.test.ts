import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "./config";

const valid = { DATABASE_URL: "postgres://dalva:s3cret-pass@db:5432/dalva" };

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig(valid)).toEqual({ ...valid, DATABASE_POOL_MAX: 10, PORT: 4000, LOG_LEVEL: "info" });
  });

  it("names every bad variable without echoing its value", () => {
    const error = (() => {
      try {
        loadConfig({ DATABASE_URL: "mysql://root:s3cret-pass@db/x", PORT: "70000", DATABASE_POOL_MAX: "" });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain("DATABASE_URL must be a postgres:// URL");
    expect(message).toContain("PORT");
    expect(message).not.toContain("DATABASE_POOL_MAX");
    expect(message).not.toContain("s3cret-pass");
  });

  it("requires DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow("DATABASE_URL is required");
  });
});
