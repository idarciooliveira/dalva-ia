import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  bearerAuthorization,
  ERROR_STATUS,
  errorCodeSchema,
  errorEnvelopeSchema,
  fail,
  idempotencyKeySchema,
  ok,
  parseBearerToken,
  successEnvelope,
  validationIssues,
} from "./envelope";

describe("envelope", () => {
  it("round-trips success and error envelopes", () => {
    const schema = successEnvelope(z.object({ n: z.number() }));
    expect(schema.parse(ok({ n: 1 }))).toEqual({ ok: true, data: { n: 1 } });
    expect(schema.safeParse(ok({ n: "1" })).success).toBe(false);
    expect(schema.safeParse(fail("internal", "x")).success).toBe(false);

    const err = fail("validation_failed", "bad", { issues: [] });
    expect(errorEnvelopeSchema.parse(err)).toEqual(err);
    expect(fail("not_found", "nope")).toEqual({ ok: false, error: { code: "not_found", message: "nope" } });
  });

  it("has a status for every error code", () => {
    for (const code of errorCodeSchema.options) expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    expect(errorCodeSchema.options).toEqual([
      "unauthorized",
      "forbidden",
      "not_found",
      "validation_failed",
      "conflict",
      "rate_limited",
      "internal",
    ]);
  });

  it("formats and parses bearer headers", () => {
    expect(bearerAuthorization("abc")).toBe("Bearer abc");
    expect(parseBearerToken("Bearer abc")).toBe("abc");
    expect(parseBearerToken("bearer abc")).toBe("abc");
    for (const bad of [null, undefined, "", "Bearer", "Bearer a b", "Basic abc", "abc"]) {
      expect(parseBearerToken(bad)).toBeNull();
    }
  });

  it("validates idempotency keys", () => {
    expect(idempotencyKeySchema.safeParse("3f2b6c1e-8d7a-4c11-9a52-0a1b2c3d4e5f").success).toBe(true);
    expect(idempotencyKeySchema.safeParse("short").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("has space in it").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("x".repeat(129)).success).toBe(false);
  });

  it("summarises zod issues for validation_failed", () => {
    const result = z.object({ a: z.object({ b: z.number() }) }).safeParse({ a: { b: "x" } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(validationIssues(result.error)).toEqual({
        issues: [{ path: "a.b", message: expect.any(String) }],
      });
    }
  });
});
