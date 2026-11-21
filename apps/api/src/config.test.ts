import { describe, expect, it } from "vitest";

import { ConfigError, configSecrets, loadConfig } from "./config";

const valid = {
  DATABASE_URL: "postgres://dalva:s3cret-pass@db:5432/dalva",
  PUBLIC_URL: "https://dalva.example.com",
  BETTER_AUTH_SECRET: "x".repeat(32),
  FINANCE_API_TOKEN_SECRET: "t".repeat(32),
};

const service = { FINANCE_API_SERVICE_KEY: "s".repeat(32) };

function configError(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig(valid)).toEqual({
      ...valid,
      NODE_ENV: "development",
      DATABASE_POOL_MAX: 10,
      PORT: 4000,
      LOG_LEVEL: "info",
    });
  });

  it("names every bad variable without echoing its value", () => {
    const message = configError({
      ...valid,
      DATABASE_URL: "mysql://root:s3cret-pass@db/x",
      PORT: "70000",
      DATABASE_POOL_MAX: "",
      BETTER_AUTH_SECRET: "too-short-secret",
    });
    expect(message).toContain("DATABASE_URL must be a postgres:// URL");
    expect(message).toContain("PORT");
    expect(message).toContain("BETTER_AUTH_SECRET must be at least 32 chars");
    expect(message).not.toContain("DATABASE_POOL_MAX");
    expect(message).not.toContain("s3cret-pass");
    expect(message).not.toContain("too-short-secret");
  });

  it("requires the database, the public origin and the auth secret", () => {
    const message = configError({});
    expect(message).toContain("DATABASE_URL is required");
    expect(message).toContain("PUBLIC_URL is required");
    expect(message).toContain("BETTER_AUTH_SECRET is required");
    expect(message).toContain("FINANCE_API_TOKEN_SECRET is required");
  });

  it("requires a token secret of 32 bytes or more, distinct from the auth secret", () => {
    expect(configError({ ...valid, FINANCE_API_TOKEN_SECRET: "short" })).toContain("FINANCE_API_TOKEN_SECRET must be at least 32 bytes");
    expect(configError({ ...valid, FINANCE_API_TOKEN_SECRET: valid.BETTER_AUTH_SECRET })).toContain(
      "FINANCE_API_TOKEN_SECRET must differ from BETTER_AUTH_SECRET",
    );
    expect(configError({ ...valid, FINANCE_API_TOKEN_SECRET: "replace-with-openssl-rand-hex-32-output-000000" })).toContain(
      "FINANCE_API_TOKEN_SECRET must not be the .env.example placeholder",
    );
  });

  it("refuses the .env.example placeholder secret", () => {
    expect(configError({ ...valid, BETTER_AUTH_SECRET: "replace-with-openssl-rand-hex-32-output-000000" })).toContain(
      "BETTER_AUTH_SECRET must not be the .env.example placeholder",
    );
  });

  it("takes PUBLIC_URL as an origin only", () => {
    expect(loadConfig({ ...valid, PUBLIC_URL: "http://localhost:3000/" }).PUBLIC_URL).toBe("http://localhost:3000");
    expect(configError({ ...valid, PUBLIC_URL: "https://dalva.example.com/app" })).toContain("PUBLIC_URL must be an origin");
    expect(configError({ ...valid, PUBLIC_URL: "ftp://dalva.example.com" })).toContain("PUBLIC_URL must be an http(s) origin");
  });

  it("requires https and a client IP header in production", () => {
    const message = configError({ ...valid, NODE_ENV: "production", PUBLIC_URL: "http://dalva.example.com" });
    expect(message).toContain("PUBLIC_URL must be https in production");
    expect(message).toContain("CLIENT_IP_HEADER is required in production");
    expect(message).toContain("FINANCE_API_SERVICE_KEY is required in production");
    const config = loadConfig({ ...valid, ...service, NODE_ENV: "production", CLIENT_IP_HEADER: "CF-Connecting-IP" });
    expect(config.CLIENT_IP_HEADER).toBe("cf-connecting-ip");
    expect(configError({ ...valid, CLIENT_IP_HEADER: "x forwarded" })).toContain("CLIENT_IP_HEADER must be a header name");
  });

  it("takes an optional service key of 32 bytes or more, distinct from both secrets", () => {
    expect(loadConfig(valid).FINANCE_API_SERVICE_KEY).toBeUndefined();
    expect(loadConfig({ ...valid, ...service }).FINANCE_API_SERVICE_KEY).toBe(service.FINANCE_API_SERVICE_KEY);
    expect(configError({ ...valid, FINANCE_API_SERVICE_KEY: "short" })).toContain("FINANCE_API_SERVICE_KEY must be at least 32 bytes");
    expect(configError({ ...valid, FINANCE_API_SERVICE_KEY: valid.FINANCE_API_TOKEN_SECRET })).toContain(
      "FINANCE_API_SERVICE_KEY must differ from FINANCE_API_TOKEN_SECRET",
    );
    expect(configError({ ...valid, FINANCE_API_SERVICE_KEY: valid.BETTER_AUTH_SECRET })).toContain(
      "FINANCE_API_SERVICE_KEY must differ from BETTER_AUTH_SECRET",
    );
    expect(configError({ ...valid, FINANCE_API_SERVICE_KEY: "replace-with-openssl-rand-hex-32-output-222222" })).toContain(
      "FINANCE_API_SERVICE_KEY must not be the .env.example placeholder",
    );
  });

  it("lists the secrets to scrub from logs", () => {
    expect(configSecrets(loadConfig(valid))).toEqual(["s3cret-pass", "x".repeat(32), "t".repeat(32)]);
    expect(configSecrets(loadConfig({ ...valid, ...service }))).toEqual([
      "s3cret-pass",
      "x".repeat(32),
      "t".repeat(32),
      service.FINANCE_API_SERVICE_KEY,
    ]);
  });
});
