import { errorEnvelopeSchema } from "@mpf/finance-contract";
import { describe, expect, it } from "vitest";

import { testDb } from "../test/db";
import { createApp } from "./app";
import { createDatabase } from "./db/client";
import { createLogger } from "./log";

const silent = createLogger({ level: "error", write: () => {} });

describe("GET /health", () => {
  it("reports the database up", async () => {
    const app = createApp({ db: testDb(), logger: silent });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, database: "up" });
  });

  it("answers 503 when the database is unreachable", async () => {
    // Nothing listens on port 1: the connection is refused at once.
    const unreachable = createDatabase({ url: "postgres://nobody:x@127.0.0.1:1/none", max: 1, connectTimeoutSeconds: 1 });
    try {
      const app = createApp({ db: unreachable.db, logger: silent, healthTimeoutMs: 3_000 });
      const res = await app.request("/health");
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, database: "down" });
    } finally {
      await unreachable.close(0);
    }
  });
});

describe("fallbacks", () => {
  it("answers unknown routes with the contract's not_found envelope", async () => {
    const res = await createApp({ db: testDb(), logger: silent }).request("/nope");
    expect(res.status).toBe(404);
    expect(errorEnvelopeSchema.parse(await res.json()).error.code).toBe("not_found");
  });

  it("answers thrown errors with internal and logs only the error's name and code", async () => {
    const lines: string[] = [];
    const app = createApp({ db: testDb(), logger: createLogger({ level: "error", write: (line) => lines.push(line) }) });
    app.get("/boom", () => {
      throw Object.assign(new Error("secret detail"), { code: "XX000" });
    });
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    expect(errorEnvelopeSchema.parse(await res.json()).error.code).toBe("internal");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "error", msg: "request_failed", path: "/boom", errorCode: "XX000" });
    expect(lines[0]).not.toContain("secret detail");
  });
});
