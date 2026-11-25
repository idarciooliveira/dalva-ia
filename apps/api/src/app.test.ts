import { describe, expect, it } from "vitest";

import { apiCodeOf, silentLogger as silent, testApp, testTokens, TEST_AUTH_SECRET, TEST_PUBLIC_URL, testSecretBox } from "../test/app";
import { fakeTelegram } from "../test/telegram";
import { createApp } from "./app";
import { createAuth } from "./auth/auth";
import { createDatabase } from "./db/client";
import { createLogger } from "./log";

describe("GET /health", () => {
  it("reports the database up", async () => {
    const res = await testApp().app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, database: "up" });
  });

  it("answers 503 when the database is unreachable", async () => {
    // Nothing listens on port 1: the connection is refused at once.
    const unreachable = createDatabase({ url: "postgres://nobody:x@127.0.0.1:1/none", max: 1, connectTimeoutSeconds: 1 });
    try {
      const auth = createAuth({ db: unreachable.db, logger: silent, publicUrl: TEST_PUBLIC_URL, secret: TEST_AUTH_SECRET });
      const app = createApp({ db: unreachable.db, logger: silent, auth, tokens: testTokens, publicUrl: TEST_PUBLIC_URL, secretBox: testSecretBox, telegram: fakeTelegram(), healthTimeoutMs: 3_000 });
      const res = await app.request("/health");
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, database: "down" });
    } finally {
      await unreachable.close(0);
    }
  });
});

describe("fallbacks", () => {
  it("answers unknown routes with not_found", async () => {
    const res = await testApp().app.request("/nope");
    expect(res.status).toBe(404);
    expect(await apiCodeOf(res)).toBe("not_found");
  });

  it("answers thrown errors with internal and logs only the error's name and code", async () => {
    const lines: string[] = [];
    const { app } = testApp({ logger: createLogger({ level: "error", write: (line) => lines.push(line) }) });
    app.get("/boom", () => {
      throw Object.assign(new Error("secret detail"), { code: "XX000" });
    });
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    expect(await apiCodeOf(res)).toBe("internal");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "error", msg: "request_failed", path: "/boom", errorCode: "XX000" });
    expect(lines[0]).not.toContain("secret detail");
  });
});
