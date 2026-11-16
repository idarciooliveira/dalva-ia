import { errorEnvelopeSchema } from "@mpf/finance-contract";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { silentLogger, testApp, TEST_AUTH_SECRET, TEST_PUBLIC_URL } from "../../test/app";
import { testDb } from "../../test/db";
import { createApp } from "../app";
import { createAuth } from "../auth/auth";
import { createDatabase } from "../db/client";
import { authSessions } from "../db/schema";
import { requireUser, userPrincipal } from "./principal";

type App = ReturnType<typeof testApp>["app"];

function withTestRoutes(app: App) {
  app.get("/api/v1/__test/me", requireUser("finance:read", "finance:write"), (c) => c.json({ ok: true, data: userPrincipal(c) }));
  app.get("/api/v1/__test/agent-only", requireUser("agent:state"), (c) => c.json({ ok: true, data: null }));
  app.post("/api/v1/__test/write", requireUser("finance:write"), (c) => c.json({ ok: true, data: null }));
  return app;
}

async function signedIn() {
  const app = withTestRoutes(testApp().app);
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: TEST_PUBLIC_URL },
    body: JSON.stringify({ name: "Ana", email: "ana@example.com", password: "correct horse battery" }),
  });
  const { user } = (await res.json()) as { user: { id: string } };
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("dalva.session_token="))!.split(";")[0]!;
  return { app, cookie, userId: user.id };
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(errorEnvelopeSchema.parse(await res.json()).error.code).toBe(code);
}

describe("principal middleware", () => {
  it("turns a session cookie into a user principal with full finance access", async () => {
    const { app, cookie, userId } = await signedIn();
    const res = await app.request("/api/v1/__test/me", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { kind: "user", userId, scopes: ["finance:read", "finance:write"], via: "session" },
    });
  });

  it("answers unauthorized without credentials, or with only unrelated cookies", async () => {
    const app = withTestRoutes(testApp().app);
    await expectError(await app.request("/api/v1/__test/me"), 401, "unauthorized");
    await expectError(await app.request("/api/v1/__test/me", { headers: { cookie: "theme=dark" } }), 401, "unauthorized");
  });

  it("answers forbidden when the principal lacks a scope", async () => {
    const { app, cookie } = await signedIn();
    await expectError(await app.request("/api/v1/__test/agent-only", { headers: { cookie } }), 403, "forbidden");
  });

  it("answers unauthorized for a forged or unknown session cookie", async () => {
    const { app, cookie } = await signedIn();
    const [name] = cookie.split("=");
    const forged = `${name}=${"a".repeat(32)}.${"b".repeat(43)}`;
    await expectError(await app.request("/api/v1/__test/me", { headers: { cookie: forged } }), 401, "unauthorized");
  });

  it("answers unauthorized for an expired session and clears the cookie", async () => {
    const { app, cookie } = await signedIn();
    await testDb().update(authSessions).set({ expiresAt: new Date(Date.now() - 60_000) });
    const res = await app.request("/api/v1/__test/me", { headers: { cookie } });
    expect(res.headers.getSetCookie().some((c) => /^dalva\.session_token=;/.test(c) && /max-age=0/i.test(c))).toBe(true);
    await expectError(res, 401, "unauthorized");
  });

  it("refuses cookie-authenticated writes from another origin (e.g. a sibling subdomain)", async () => {
    const { app, cookie } = await signedIn();
    const write = (headers: Record<string, string>) => app.request("/api/v1/__test/write", { method: "POST", headers: { cookie, ...headers } });
    await expectError(await write({ origin: "https://evil.dalva.example.com" }), 401, "unauthorized");
    expect((await write({ origin: TEST_PUBLIC_URL })).status).toBe(200);
    expect((await write({})).status).toBe(200);
  });

  it("never falls back to the cookie when the request carries Authorization", async () => {
    const { app, cookie } = await signedIn();
    const res = await app.request("/api/v1/__test/me", { headers: { cookie, authorization: "Bearer not-a-known-token" } });
    await expectError(res, 401, "unauthorized");
  });

  it("renews a session that is due, and sends the new cookie with the route's answer", async () => {
    const { app, cookie } = await signedIn();
    // Last renewed more than a day ago: 29 days and 1 hour left of 30.
    await testDb()
      .update(authSessions)
      .set({ expiresAt: sql`now() + interval '29 days' - interval '1 hour'` });
    const res = await app.request("/api/v1/__test/me", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => /^dalva\.session_token=[^;]+;/.test(c) && /max-age=2592000/i.test(c))).toBe(true);
    const [session] = await testDb().select().from(authSessions);
    expect(session!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29.9 * 24 * 60 * 60 * 1000);
  });

  it("fails closed, with internal, when the session can't be checked", async () => {
    const { cookie } = await signedIn();
    const unreachable = createDatabase({ url: "postgres://nobody:x@127.0.0.1:1/none", max: 1, connectTimeoutSeconds: 1 });
    try {
      const auth = createAuth({ db: unreachable.db, logger: silentLogger, publicUrl: TEST_PUBLIC_URL, secret: TEST_AUTH_SECRET });
      const app = withTestRoutes(createApp({ db: unreachable.db, logger: silentLogger, auth, publicUrl: TEST_PUBLIC_URL }));
      const res = await app.request("/api/v1/__test/me", { headers: { cookie } });
      await expectError(res, 500, "internal");
    } finally {
      await unreachable.close(0);
    }
  });

  it("leaves auth and health routes alone", async () => {
    const app = withTestRoutes(testApp().app);
    expect((await app.request("/health", { headers: { authorization: "Bearer x" } })).status).toBe(200);
    expect((await app.request("/api/auth/get-session", { headers: { authorization: "Bearer x" } })).status).toBe(200);
  });
});
