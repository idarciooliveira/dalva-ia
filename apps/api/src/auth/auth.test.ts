/** Sign-up, sign-in, sign-out and session handling, through HTTP like the web app will use them. */
import { errorEnvelopeSchema } from "@mpf/finance-contract";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { testApp, testTokens, TEST_AUTH_SECRET, TEST_PUBLIC_URL } from "../../test/app";
import { testDb } from "../../test/db";
import { createApp } from "../app";
import { createDatabase } from "../db/client";
import { authAccounts, authSessions, users } from "../db/schema";
import { requireUser, userPrincipal } from "../http/principal";
import { createLogger } from "../log";
import { createAuth } from "./auth";
import { createSignInLimiter } from "./sign-in-limit";

type App = ReturnType<typeof testApp>["app"];

const PASSWORD = "correct horse battery";

function setup(options: { publicUrl?: string } = {}) {
  const { app, auth } = testApp(options);
  // Test-only protected routes: the principal middleware is all this PR adds to /api/v1.
  app.get("/api/v1/__test/me", requireUser("finance:read"), (c) => c.json({ ok: true, data: userPrincipal(c) }));
  app.get("/api/v1/__test/agent-only", requireUser("agent:state"), (c) => c.json({ ok: true, data: null }));
  return { app, auth, origin: options.publicUrl ?? TEST_PUBLIC_URL };
}

function post(app: App, path: string, body: unknown, headers: Record<string, string> = {}, origin = TEST_PUBLIC_URL) {
  return app.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: JSON.stringify(body),
  });
}

/** `name=value` of the session cookie a response sets, for the next request's Cookie header. */
function sessionCookie(res: Response): string {
  const header = res.headers.getSetCookie().find((cookie) => /^(__Secure-)?dalva\.session_token=/.test(cookie));
  if (!header) throw new Error(`no session cookie in ${JSON.stringify(res.headers.getSetCookie())}`);
  return header.split(";")[0]!;
}

async function signUp(app: App, email = "ana@example.com", password = PASSWORD) {
  const res = await post(app, "/sign-up/email", { name: "Ana", email, password });
  expect(res.status).toBe(200);
  return sessionCookie(res);
}

const me = (app: App, headers: Record<string, string> = {}) => app.request("/api/v1/__test/me", { headers });

async function errorCode(res: Response) {
  return errorEnvelopeSchema.parse(await res.json()).error.code;
}

describe("sign-up", () => {
  it("creates the user, a scrypt credential and a session, and signs in", async () => {
    const { app } = setup();
    const res = await post(app, "/sign-up/email", { name: "Ana", email: "Ana@Example.com", password: PASSWORD });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; email: string; name: string } };
    expect(body.user).toMatchObject({ email: "ana@example.com", name: "Ana" });

    const [version] = await testDb().execute<{ v: number }>(sql`select uuid_extract_version(${body.user.id}::uuid) as v`);
    expect(version!.v).toBe(7);
    const [credential] = await testDb().select().from(authAccounts).where(eq(authAccounts.userId, body.user.id));
    expect(credential).toMatchObject({ providerId: "credential", accountId: body.user.id });
    expect(credential!.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);

    const cookie = sessionCookie(res);
    expect((await me(app, { cookie })).status).toBe(200);
  });

  it("refuses an email that is already registered, in any case", async () => {
    const { app } = setup();
    await signUp(app, "ana@example.com");
    const res = await post(app, "/sign-up/email", { name: "Other", email: "ANA@example.com", password: "another password" });
    expect(res.status).toBe(422);
    expect(await testDb().select().from(users)).toHaveLength(1);
  });

  it("lets only one of two concurrent sign-ups with the same email through", async () => {
    const { app } = setup();
    const body = { name: "Ana", email: "race@example.com", password: PASSWORD };
    const responses = await Promise.all([post(app, "/sign-up/email", body), post(app, "/sign-up/email", body)]);
    // The loser hits the unique email index: a clean 422, not a 500.
    expect(responses.map((res) => res.status).sort()).toEqual([200, 422]);
    expect(await testDb().select().from(users)).toHaveLength(1);
  });

  it("requires a password of at least 8 characters, as Convex Auth did", async () => {
    const { app } = setup();
    const short = await post(app, "/sign-up/email", { name: "Ana", email: "ana@example.com", password: "1234567" });
    expect(short.status).toBe(400);
    expect(((await short.json()) as { code: string }).code).toBe("PASSWORD_TOO_SHORT");
    await signUp(app, "ana@example.com", "12345678");
  });

  it("accepts long passwords (Convex Auth had no maximum)", async () => {
    const { app } = setup();
    await signUp(app, "ana@example.com", "p".repeat(500));
  });

  it("requires a valid email", async () => {
    const { app } = setup();
    const res = await post(app, "/sign-up/email", { name: "Ana", email: "not-an-email", password: PASSWORD });
    expect(res.status).toBe(400);
    expect(await testDb().select().from(users)).toHaveLength(0);
  });

  it("refuses sign-up and sign-in posted from another site", async () => {
    const { app } = setup();
    const evil = "https://evil.example";
    const signUpRes = await post(app, "/sign-up/email", { name: "Ana", email: "ana@example.com", password: PASSWORD }, {}, evil);
    expect(signUpRes.status).toBe(403);
    expect(await testDb().select().from(users)).toHaveLength(0);

    await signUp(app);
    const signInRes = await post(app, "/sign-in/email", { email: "ana@example.com", password: PASSWORD }, {}, evil);
    expect(signInRes.status).toBe(403);
    expect(signInRes.headers.getSetCookie()).toEqual([]);
  });
});

describe("sign-in", () => {
  it("signs in with the right password, whatever the email's case", async () => {
    const { app } = setup();
    await signUp(app, "ana@example.com");
    const res = await post(app, "/sign-in/email", { email: "ANA@example.com", password: PASSWORD });
    expect(res.status).toBe(200);
    expect((await me(app, { cookie: sessionCookie(res) })).status).toBe(200);
  });

  it("answers a wrong password and an unknown email the same way, with no session", async () => {
    const { app } = setup();
    await signUp(app, "ana@example.com");
    const wrong = await post(app, "/sign-in/email", { email: "ana@example.com", password: "wrong password" });
    const unknown = await post(app, "/sign-in/email", { email: "nobody@example.com", password: PASSWORD });
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe("INVALID_EMAIL_OR_PASSWORD");
      expect(res.headers.getSetCookie().some((cookie) => cookie.includes("session_token=") && !/max-age=0/i.test(cookie))).toBe(false);
    }
  });
});

describe("exposed routes", () => {
  it("serves only the auth routes the app uses", async () => {
    const { app } = setup();
    const cookie = await signUp(app);
    for (const [method, path] of [
      ["POST", "/update-user"],
      ["GET", "/list-sessions"],
      ["GET", "/verify-email?token=x"],
      ["POST", "/verify-password"],
      ["POST", "/change-email"],
      ["POST", "/delete-user"],
      ["GET", "/ok"],
    ] as const) {
      const res = await app.request(`/api/auth${path}`, {
        method,
        headers: { cookie, origin: TEST_PUBLIC_URL, "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect([path, res.status]).toEqual([path, 404]);
    }
  });
});

describe("unexpected errors", () => {
  it("answer internal and log no query, email or stack", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", write: (line) => lines.push(line) });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const unreachable = createDatabase({ url: "postgres://nobody:x@127.0.0.1:1/none", max: 1, connectTimeoutSeconds: 1 });
    try {
      const auth = createAuth({ db: unreachable.db, logger, publicUrl: TEST_PUBLIC_URL, secret: TEST_AUTH_SECRET });
      const app = createApp({ db: unreachable.db, logger, auth, tokens: testTokens, publicUrl: TEST_PUBLIC_URL });
      const res = await post(app, "/sign-in/email", { email: "secret-person@example.com", password: PASSWORD });
      expect(res.status).toBe(500);
      expect(await errorCode(res)).toBe("internal");
      expect(consoleError).not.toHaveBeenCalled();
      expect(lines.join("\n")).not.toMatch(/secret-person|select|insert/i);
    } finally {
      consoleError.mockRestore();
      await unreachable.close(0);
    }
  });
});

describe("rate limits", () => {
  it("block an account after 10 failed sign-ins in an hour, as Convex Auth did", async () => {
    const { app } = setup();
    await signUp(app, "ana@example.com");
    await signUp(app, "bea@example.com");
    for (let i = 0; i < 10; i++) {
      expect((await post(app, "/sign-in/email", { email: "ana@example.com", password: `wrong ${i} password` })).status).toBe(401);
    }
    // Even the right password, from any address, until the hour is over.
    const blocked = await post(app, "/sign-in/email", { email: "ANA@example.com", password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.getSetCookie()).toEqual([]);
    expect((await post(app, "/sign-in/email", { email: "bea@example.com", password: PASSWORD })).status).toBe(200);
  });

  it("hold under concurrent guesses and refuse non-JSON sign-ins", async () => {
    const { app } = setup();
    await signUp(app, "ana@example.com");
    const guesses = await Promise.all(
      Array.from({ length: 25 }, (_, i) => post(app, "/sign-in/email", { email: "ana@example.com", password: `wrong ${i} password` })),
    );
    expect(guesses.filter((res) => res.status === 401)).toHaveLength(10);
    expect(guesses.filter((res) => res.status === 429)).toHaveLength(15);

    const form = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "ana@example.com", password: PASSWORD }).toString(),
    });
    expect(form.status).toBe(415);
  });

  it("forget an account's failures after a successful sign-in", async () => {
    // A limit of 3 keeps the number of scrypt hashes (and the test's run time) down.
    const { app } = testApp({ signInLimiter: createSignInLimiter({ maxFailures: 3 }) });
    await signUp(app, "ana@example.com");
    for (let i = 0; i < 2; i++) await post(app, "/sign-in/email", { email: "ana@example.com", password: "wrong password" });
    expect((await post(app, "/sign-in/email", { email: "ana@example.com", password: PASSWORD })).status).toBe(200);
    for (let i = 0; i < 2; i++) await post(app, "/sign-in/email", { email: "ana@example.com", password: "wrong password" });
    expect((await post(app, "/sign-in/email", { email: "ana@example.com", password: PASSWORD })).status).toBe(200);
  });


  it("limit sign-in attempts per client address, from the configured header only", async () => {
    const { app } = testApp({ clientIpHeader: "x-real-ip" });
    const attempt = (ip: string) =>
      post(app, "/sign-in/email", { email: "nobody@example.com", password: PASSWORD }, { "x-real-ip": ip, "x-forwarded-for": "9.9.9.9" });
    const first = [await attempt("203.0.113.7"), await attempt("203.0.113.7"), await attempt("203.0.113.7")];
    expect(first.map((res) => res.status)).toEqual([401, 401, 401]);
    expect((await attempt("203.0.113.7")).status).toBe(429);
    // Another client is not affected by the first one's attempts.
    expect((await attempt("198.51.100.2")).status).toBe(401);
  });
});

describe("session", () => {
  it("reads the session with the cookie, and none without", async () => {
    const { app } = setup();
    const cookie = await signUp(app);
    const withCookie = await app.request("/api/auth/get-session", { headers: { cookie } });
    expect(((await withCookie.json()) as { user: { email: string } }).user.email).toBe("ana@example.com");
    const without = await app.request("/api/auth/get-session");
    expect(await without.json()).toBeNull();
  });

  it("signs out: the session row is gone and the cookie no longer works", async () => {
    const { app } = setup();
    const cookie = await signUp(app);
    const res = await post(app, "/sign-out", {}, { cookie });
    expect(res.status).toBe(200);
    // The browser is told to drop the cookie.
    expect(res.headers.getSetCookie().some((c) => /^dalva\.session_token=;/.test(c) && /max-age=0/i.test(c))).toBe(true);
    expect(await testDb().select().from(authSessions)).toHaveLength(0);

    expect(await (await app.request("/api/auth/get-session", { headers: { cookie } })).json()).toBeNull();
    const protectedRes = await me(app, { cookie });
    expect(protectedRes.status).toBe(401);
    expect(await errorCode(protectedRes)).toBe("unauthorized");
  });

  it("sets an httpOnly, SameSite=Lax, 30-day cookie, not Secure over http", async () => {
    const { app } = setup();
    const res = await post(app, "/sign-up/email", { name: "Ana", email: "ana@example.com", password: PASSWORD });
    const header = res.headers.getSetCookie().find((c) => c.startsWith("dalva.session_token="))!;
    const attributes = header.split(";").map((part) => part.trim().toLowerCase());
    expect(attributes).toEqual(
      expect.arrayContaining(["httponly", "samesite=lax", "path=/", `max-age=${30 * 24 * 60 * 60}`]),
    );
    expect(attributes).not.toContain("secure");
  });

  it("sets a Secure, __Secure- prefixed cookie when the public origin is https", async () => {
    const publicUrl = "https://dalva.example.com";
    const { app } = setup({ publicUrl });
    const res = await post(app, "/sign-up/email", { name: "Ana", email: "ana@example.com", password: PASSWORD }, {}, publicUrl);
    expect(res.status).toBe(200);
    const header = res.headers.getSetCookie().find((c) => c.startsWith("__Secure-dalva.session_token="))!;
    const attributes = header.split(";").map((part) => part.trim().toLowerCase());
    expect(attributes).toEqual(expect.arrayContaining(["secure", "httponly", "samesite=lax", "path=/"]));
    expect((await me(app, { cookie: sessionCookie(res) })).status).toBe(200);
  });
});

describe("legacy password hashes (Convex Auth)", () => {
  // Generated once with `new Scrypt().hash(password)` from lucia@3.2.2, the hasher of
  // @convex-dev/auth's Password provider. lucia is not a dependency of this package.
  const LUCIA_HASHES = [
    {
      password: "correct horse battery staple",
      hash: "df9a91756533bb2f19ac803ae304b64f:b7b6522700874ff4746820259f3fba7dbeaaf3bdf3e73845989bd824d573ebd7c0b7e7e43b745067a7ff7ea1aa8986288af10871aebf881115281e4dd5de3c1b",
    },
    {
      // NFKC-normalised before hashing: the "ﬁ" ligature counts as "fi".
      password: "Pässwörd-ﬁ 123",
      hash: "63ae00b0912f1567f66e3743b394d851:03ec80f94b509450488954eb399cda4436e9984d9fbff278be976e494b1944602cdb6a16f477e48232f78340c15a2ee0f7ef3fcf88ec199b918dd8f37b80ba1a",
    },
  ];

  it("verifies Lucia Scrypt hashes with Better Auth's verifier", async () => {
    const { auth } = setup();
    const { password } = await auth.$context;
    for (const fixture of LUCIA_HASHES) {
      expect(await password.verify({ hash: fixture.hash, password: fixture.password })).toBe(true);
      expect(await password.verify({ hash: fixture.hash, password: `${fixture.password}x` })).toBe(false);
    }
    expect(await password.verify({ hash: LUCIA_HASHES[1]!.hash, password: "Pässwörd-fi 123" })).toBe(true);
  });

  it("signs in an imported user whose credential is a Lucia hash", async () => {
    const { app } = setup();
    // What the Convex import will write: the user, and the hash as the credential password.
    const [user] = await testDb().insert(users).values({ name: "Imported", email: "old@example.com" }).returning();
    await testDb()
      .insert(authAccounts)
      .values({ userId: user!.id, providerId: "credential", accountId: user!.id, password: LUCIA_HASHES[1]!.hash });

    const ok = await post(app, "/sign-in/email", { email: "old@example.com", password: LUCIA_HASHES[1]!.password });
    expect(ok.status).toBe(200);
    expect(await (await me(app, { cookie: sessionCookie(ok) })).json()).toMatchObject({ data: { userId: user!.id } });

    const wrong = await post(app, "/sign-in/email", { email: "old@example.com", password: "Pässwörd-ﬁ 124" });
    expect(wrong.status).toBe(401);
  });
});
