import { describe, expect, test } from "vitest";

import { ConfigError, loadConfig } from "../src/config";
import { BOT_TOKEN, SERVICE_KEY, WEBHOOK_SECRET } from "./helpers";

const env = {
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
  TELEGRAM_MODE: "webhook",
  TELEGRAM_BOT_USERNAME: "@dalva_test_bot",
  FINANCE_API_URL: "https://finance.test/",
  FINANCE_API_SERVICE_KEY: SERVICE_KEY,
};

describe("loadConfig", () => {
  test("parses a valid env and applies defaults", () => {
    expect(loadConfig(env)).toMatchObject({
      TELEGRAM_MODE: "webhook",
      TELEGRAM_BOT_USERNAME: "dalva_test_bot",
      FINANCE_API_URL: "https://finance.test",
      PORT: 8080,
      LOG_LEVEL: "info",
      SESSION_IDLE_MINUTES: 30,
    });
  });

  test("coerces numbers", () => {
    expect(loadConfig({ ...env, PORT: "3001", SESSION_IDLE_MINUTES: "15" })).toMatchObject({ PORT: 3001, SESSION_IDLE_MINUTES: 15 });
  });

  test("names every missing variable", () => {
    expect.assertions(5);
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({ TELEGRAM_MODE: "polling" });
    } catch (error) {
      const message = (error as Error).message;
      for (const name of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "FINANCE_API_URL", "FINANCE_API_SERVICE_KEY"]) {
        expect(message).toContain(name);
      }
    }
  });

  test("requires the webhook secret in webhook mode only", () => {
    const { TELEGRAM_WEBHOOK_SECRET: _omit, ...withoutSecret } = env;
    expect(() => loadConfig(withoutSecret)).toThrow(/TELEGRAM_WEBHOOK_SECRET is required in webhook mode/);
    expect(loadConfig({ ...withoutSecret, TELEGRAM_MODE: "polling" }).TELEGRAM_MODE).toBe("polling");
  });

  test("treats empty values as unset", () => {
    expect(() => loadConfig({ ...env, FINANCE_API_SERVICE_KEY: "" })).toThrow(/FINANCE_API_SERVICE_KEY is required/);
  });

  test("rejects bad values without echoing them", () => {
    const badKey = "short-secret-value";
    const badToken = "not-a-real-token-value";
    let message = "";
    try {
      loadConfig({ ...env, FINANCE_API_SERVICE_KEY: badKey, TELEGRAM_BOT_TOKEN: badToken, TELEGRAM_MODE: "both", PORT: "x" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/FINANCE_API_SERVICE_KEY/);
    expect(message).toMatch(/TELEGRAM_BOT_TOKEN/);
    expect(message).toMatch(/TELEGRAM_MODE/);
    expect(message).toMatch(/PORT/);
    expect(message).not.toContain(badKey);
    expect(message).not.toContain(badToken);
  });
});
