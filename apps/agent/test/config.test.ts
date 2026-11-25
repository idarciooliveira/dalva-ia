import { describe, expect, test } from "vitest";

import { ConfigError, loadConfig } from "../src/config";
import { SERVICE_KEY } from "./helpers";

const env = {
  FINANCE_API_URL: "https://finance.test/",
  FINANCE_API_SERVICE_KEY: SERVICE_KEY,
};

describe("loadConfig", () => {
  test("needs only the API and its service key; the rest has defaults", () => {
    expect(loadConfig(env)).toMatchObject({
      FINANCE_API_URL: "https://finance.test",
      PORT: 8080,
      LOG_LEVEL: "info",
      SESSION_IDLE_MINUTES: 30,
      AGENT_MAX_STEPS: 6,
      AGENT_MAX_OUTPUT_TOKENS: 1024,
      AGENT_TURN_TIMEOUT_SECONDS: 45,
      AGENT_RATE_LIMIT_TURNS: 20,
      AGENT_RATE_LIMIT_WINDOW_MINUTES: 10,
      DEFAULT_TIMEZONE: "Africa/Luanda",
    });
  });

  test("ignores the Telegram and AI variables it used to read (they live in the instance settings now)", () => {
    const config = loadConfig({ ...env, TELEGRAM_BOT_TOKEN: "x", TELEGRAM_MODE: "webhook", AI_PROVIDER: "gateway", AGENT_MODEL: "m" }) as Record<string, unknown>;
    for (const name of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_MODE", "AI_PROVIDER", "AGENT_MODEL"]) expect(config[name]).toBeUndefined();
  });

  test("coerces numbers", () => {
    expect(loadConfig({ ...env, PORT: "3001", SESSION_IDLE_MINUTES: "15" })).toMatchObject({ PORT: 3001, SESSION_IDLE_MINUTES: 15 });
  });

  test("names every missing variable", () => {
    expect.assertions(3);
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
    } catch (error) {
      const message = (error as Error).message;
      for (const name of ["FINANCE_API_URL", "FINANCE_API_SERVICE_KEY"]) expect(message).toContain(name);
    }
  });

  test("treats empty values as unset", () => {
    expect(() => loadConfig({ ...env, FINANCE_API_SERVICE_KEY: "" })).toThrow(/FINANCE_API_SERVICE_KEY is required/);
  });

  test("rejects bad values without echoing them", () => {
    const badKey = "short-secret-value";
    let message = "";
    try {
      loadConfig({ ...env, FINANCE_API_SERVICE_KEY: badKey, PORT: "x" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/FINANCE_API_SERVICE_KEY/);
    expect(message).toMatch(/PORT/);
    expect(message).not.toContain(badKey);
  });

  test("validates limits and the timezone", () => {
    expect(loadConfig({ ...env, AGENT_MAX_STEPS: "3", AGENT_MAX_OUTPUT_TOKENS: "800" })).toMatchObject({ AGENT_MAX_STEPS: 3, AGENT_MAX_OUTPUT_TOKENS: 800 });
    expect(() => loadConfig({ ...env, AGENT_MAX_STEPS: "0" })).toThrow(/AGENT_MAX_STEPS/);
    expect(() => loadConfig({ ...env, AGENT_MAX_STEPS: "50" })).toThrow(/AGENT_MAX_STEPS/);
    expect(() => loadConfig({ ...env, DEFAULT_TIMEZONE: "Mars/Olympus" })).toThrow(/DEFAULT_TIMEZONE/);
    expect(loadConfig({ ...env, DEFAULT_TIMEZONE: "Europe/Lisbon" }).DEFAULT_TIMEZONE).toBe("Europe/Lisbon");
  });
});
