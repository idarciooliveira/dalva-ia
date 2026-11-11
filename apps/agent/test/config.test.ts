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
  AI_PROVIDER: "gateway",
  AGENT_MODEL: "anthropic/claude-sonnet-5-5",
  AI_GATEWAY_API_KEY: "gw-key-0123456789",
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

describe("loadConfig: agent model", () => {
  const ai = env;

  test("parses the provider, model and defaults", () => {
    expect(loadConfig(ai)).toMatchObject({
      AI_PROVIDER: "gateway",
      AGENT_MODEL: "anthropic/claude-sonnet-5-5",
      AGENT_MAX_STEPS: 6,
      DEFAULT_TIMEZONE: "Africa/Luanda",
      AGENT_RATE_LIMIT_TURNS: 20,
      AGENT_RATE_LIMIT_WINDOW_MINUTES: 10,
      AGENT_TURN_TIMEOUT_SECONDS: 45,
    });
    expect(loadConfig(ai).AGENT_MAX_OUTPUT_TOKENS).toBeUndefined();
  });

  test("requires a provider and a model, with no default model", () => {
    const { AI_PROVIDER: _p, AGENT_MODEL: _m, ...rest } = ai;
    expect(() => loadConfig(rest)).toThrow(/AI_PROVIDER is required.*AGENT_MODEL is required|AGENT_MODEL is required/);
    expect(() => loadConfig({ ...ai, AGENT_MODEL: "" })).toThrow(/AGENT_MODEL is required/);
    expect(() => loadConfig({ ...ai, AI_PROVIDER: "openai" })).toThrow(/AI_PROVIDER/);
  });

  test("requires the key of the selected provider", () => {
    expect(() => loadConfig({ ...ai, AI_GATEWAY_API_KEY: "" })).toThrow(/AI_GATEWAY_API_KEY is required when AI_PROVIDER=gateway/);
    expect(() => loadConfig({ ...ai, AI_PROVIDER: "openrouter" })).toThrow(/OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter/);
    expect(loadConfig({ ...ai, AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "or-key-0123456789" }).AI_PROVIDER).toBe("openrouter");
  });

  test("validates limits and the timezone", () => {
    expect(loadConfig({ ...ai, AGENT_MAX_STEPS: "3", AGENT_MAX_OUTPUT_TOKENS: "800" })).toMatchObject({ AGENT_MAX_STEPS: 3, AGENT_MAX_OUTPUT_TOKENS: 800 });
    expect(() => loadConfig({ ...ai, AGENT_MAX_STEPS: "0" })).toThrow(/AGENT_MAX_STEPS/);
    expect(() => loadConfig({ ...ai, AGENT_MAX_STEPS: "50" })).toThrow(/AGENT_MAX_STEPS/);
    expect(() => loadConfig({ ...ai, DEFAULT_TIMEZONE: "Mars/Olympus" })).toThrow(/DEFAULT_TIMEZONE/);
    expect(loadConfig({ ...ai, DEFAULT_TIMEZONE: "Europe/Lisbon" }).DEFAULT_TIMEZONE).toBe("Europe/Lisbon");
  });

  test("never echoes the AI key", () => {
    try {
      loadConfig({ ...ai, AGENT_MAX_STEPS: "x" });
    } catch (error) {
      expect((error as Error).message).not.toContain("gw-key-0123456789");
    }
  });
});
