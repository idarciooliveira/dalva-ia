import { allRoutes, errorEnvelopeSchema, isWriteRoute } from "@mpf/finance-contract";
import { describe, expect, it, vi } from "vitest";

import { implementationFor } from "./registry";
import { BodyTooLargeError, readBodyText } from "./router";
import { raw, seedUser, setupApi, tokenFor, type RawResponse } from "./test.helpers";
import { mintUserToken, TOKEN_SECRET_ENV } from "./tokens";

const KEY = "router-test-key-0001";
/** Valid-looking path for a route; ids don't need to exist for auth checks. */
const pathOf = (path: string) => path.replace(/:(\w+)/g, "missing");

function expectError(response: RawResponse, code: string, status: number) {
  expect(errorEnvelopeSchema.safeParse(response.body).success).toBe(true);
  expect(response.body.error?.code).toBe(code);
  expect(response.status).toBe(status);
}

async function forgedToken(userId: string) {
  const token = await tokenFor(userId);
  const [h, p] = token.split(".");
  return `${h}.${p}.${"A".repeat(43)}`;
}

describe("api/v1 router", () => {
  it("maps every contract route to an implementation", () => {
    for (const { group, op } of allRoutes()) expect(implementationFor(group, op), `${group}.${op}`).not.toBeNull();
  });

  describe.each(allRoutes().map((r) => [r.name, r] as const))("%s auth", (_name, { route }) => {
    const path = pathOf(route.path);
    const options = isWriteRoute(route) ? { idempotencyKey: KEY, body: {} } : {};

    it("rejects a missing, malformed, forged or expired token with 401", async () => {
      const t = setupApi();
      const user = await seedUser(t);
      const now = Math.floor(Date.now() / 1000);
      const expired = await mintUserToken(user, ["finance:read", "finance:write"], 60, { now: now - 120 });

      const noToken = await raw(t, route.method, path, options);
      expectError(noToken, "unauthorized", 401);
      expect(noToken.headers.get("WWW-Authenticate")).toContain("Bearer");
      expectError(await raw(t, route.method, path, { ...options, headers: { Authorization: "Basic abc" } }), "unauthorized", 401);
      expectError(await raw(t, route.method, path, { ...options, token: "not.a.jwt" }), "unauthorized", 401);
      expectError(await raw(t, route.method, path, { ...options, token: await forgedToken(user) }), "unauthorized", 401);
      const expiredResponse = await raw(t, route.method, path, { ...options, token: expired });
      expectError(expiredResponse, "unauthorized", 401);
      expect(expiredResponse.body.error?.message).toBe("Token expired");
    });

    it("rejects a token without the required scope with 403", async () => {
      const t = setupApi();
      const user = await seedUser(t);
      const wrongScope = await tokenFor(user, [isWriteRoute(route) ? "finance:read" : "finance:write"]);
      expectError(await raw(t, route.method, path, { ...options, token: wrongScope }), "forbidden", 403);
    });

    it("dispatches to the right function kind and never 500s on unknown ids", async () => {
      const t = setupApi();
      const token = await tokenFor(await seedUser(t));
      const response = await raw(t, route.method, path, { ...options, token });
      expect([200, 400, 404]).toContain(response.status);
    });
  });

  it("returns 500 internal (no details) when the secret is not configured", async () => {
    const t = setupApi();
    const token = await tokenFor(await seedUser(t));
    vi.stubEnv(TOKEN_SECRET_ENV, "");
    expectError(await raw(t, "GET", "/accounts", { token }), "internal", 500);
  });

  it("returns not_found for unknown routes and methods", async () => {
    const t = setupApi();
    const token = await tokenFor(await seedUser(t));
    expectError(await raw(t, "GET", "/nope", { token }), "not_found", 404);
    expectError(await raw(t, "POST", "/accounts", { token, idempotencyKey: KEY, body: {} }), "not_found", 404);
    expectError(await raw(t, "GET", "/accounts/a/b", { token }), "not_found", 404);
  });

  it("validates query params and returns contract validation details", async () => {
    const t = setupApi();
    const token = await tokenFor(await seedUser(t));
    const response = await raw(t, "GET", "/transactions?limit=500&unknown=1", { token });
    expectError(response, "validation_failed", 400);
    const paths = (response.body.error?.details as { issues: Array<{ path: string }> }).issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["limit", ""]));
    expectError(await raw(t, "GET", "/reports/cashflow?month=2026-13", { token }), "validation_failed", 400);
    expectError(await raw(t, "GET", "/accounts/bad%3Bid", { token }), "validation_failed", 400);
  });

  it("requires a valid Idempotency-Key on writes", async () => {
    const t = setupApi();
    const token = await tokenFor(await seedUser(t));
    const body = { amount: { amountMinor: 1, currency: "USD" } };
    for (const idempotencyKey of [undefined, "short", "has spaces in it!"]) {
      const response = await raw(t, "POST", "/accounts/missing/adjustments", { token, body, idempotencyKey });
      expectError(response, "validation_failed", 400);
      expect(response.body.error?.message).toContain("Idempotency-Key");
    }
  });

  it("rejects malformed, non-object and oversized JSON bodies", async () => {
    const t = setupApi();
    const token = await tokenFor(await seedUser(t));
    const send = (rawBody: string) =>
      raw(t, "POST", "/transfers", { token, idempotencyKey: KEY, rawBody, headers: { "Content-Type": "application/json" } });
    expectError(await send("{nope"), "validation_failed", 400);
    expectError(await send("[1,2]"), "validation_failed", 400);
    expectError(await send("null"), "validation_failed", 400);
    expectError(await send(JSON.stringify({ note: "x".repeat(70 * 1024) })), "validation_failed", 400);
  });

  it("stops reading a chunked body without Content-Length once it passes the limit", async () => {
    const t = setupApi();
    const token = await tokenFor(await seedUser(t));
    let pulled = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode(`"${"x".repeat(16 * 1024)}",`);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled === 1) controller.enqueue(new TextEncoder().encode('{"note":['));
        else if (pulled < 1000) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await t.fetch("/api/v1/transfers", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": KEY, "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(400);
    expect(((await response.json()) as RawResponse["body"]).error?.message).toBe("Request body too large");
    expect(pulled).toBeLessThan(20);
    expect(cancelled).toBe(true);
  });

  it("readBodyText: reads small bodies and cancels past the limit", async () => {
    const stream = (parts: string[], onCancel?: () => void) => {
      const queue = [...parts];
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const part = queue.shift();
          if (part === undefined) controller.close();
          else controller.enqueue(new TextEncoder().encode(part));
        },
        cancel: onCancel,
      });
    };
    expect(await readBodyText(null, 10)).toBe("");
    expect(await readBodyText(stream(["{\"a\":", "\"é\"}"]), 64)).toBe('{"a":"é"}');
    expect(await readBodyText(stream(["12345", "67890"]), 10)).toBe("1234567890");
    let cancelled = false;
    await expect(readBodyText(stream(["12345", "678901"], () => (cancelled = true)), 10)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancelled).toBe(true);
  });

  it("takes path params over body keys and rejects unknown body keys", async () => {
    const t = setupApi();
    const token = await tokenFor(await seedUser(t));
    const response = await raw(t, "POST", "/accounts/missing/adjustments", {
      token,
      idempotencyKey: KEY,
      body: { amount: { amountMinor: 1, currency: "USD" }, extra: true },
    });
    expectError(response, "validation_failed", 400);
  });
});
