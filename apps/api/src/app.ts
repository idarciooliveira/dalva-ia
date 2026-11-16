import { API_BASE_PATH, fail } from "@mpf/finance-contract";
import { sql } from "drizzle-orm";
import { Hono } from "hono";

import { AUTH_BASE_PATH, type Auth } from "./auth/auth";
import { createSignInLimiter, type SignInLimiter } from "./auth/sign-in-limit";
import type { Database } from "./db/client";
import { type AppEnv, resolvePrincipal, sessionSource } from "./http/principal";
import { errorFields, type Logger } from "./log";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface AppOptions {
  db: Database;
  logger: Logger;
  auth: Auth;
  /** Public origin (config `PUBLIC_URL`): the only origin allowed to post to the auth routes. */
  publicUrl: string;
  /** How long `/health` waits for `select 1`. Default 2000 ms. */
  healthTimeoutMs?: number;
  /** Failed sign-ins per account. Default: 10 per hour per email. */
  signInLimiter?: SignInLimiter;
}

/**
 * The Better Auth routes the app uses. Everything else Better Auth ships
 * (update-user, list-sessions, verify-email, ...) stays unreachable until a
 * feature needs it, so a Better Auth upgrade can't expose new routes either.
 */
const AUTH_ROUTES = [
  ["POST", "/sign-up/email"],
  ["POST", "/sign-out"],
  ["GET", "/get-session"],
] as const;

export function createApp(options: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const healthTimeoutMs = options.healthTimeoutMs ?? 2_000;

  // Liveness and readiness in one: 503 while the database can't answer.
  app.get("/health", async (c) => {
    const database = await pingDatabase(options.db, healthTimeoutMs);
    return c.json({ ok: database === "up", database }, database === "up" ? 200 : 503);
  });

  // Better Auth checks Origin only on requests that carry cookies (sign-up and sign-in don't) and
  // relies on Fetch Metadata otherwise. Web and API share one origin, so refuse any auth write a
  // browser sends from another site. Clients that send no Origin (not browsers) aren't affected.
  app.use(`${AUTH_BASE_PATH}/*`, async (c, next) => {
    const origin = c.req.header("origin");
    if (!SAFE_METHODS.has(c.req.method) && origin !== undefined && origin !== options.publicUrl) {
      return c.json({ code: "INVALID_ORIGIN", message: "Invalid origin" }, 403);
    }
    await next();
  });

  // Better Auth's own routes and responses; unknown auth paths fall through to 404.
  for (const [method, path] of AUTH_ROUTES) {
    app.on(method, `${AUTH_BASE_PATH}${path}`, (c) => options.auth.handler(c.req.raw));
  }
  const signInLimiter = options.signInLimiter ?? createSignInLimiter();
  app.post(`${AUTH_BASE_PATH}/sign-in/email`, async (c) => {
    // JSON only: Better Auth also takes form bodies, which would skip the per-account limit below.
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
      return c.json({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Send the credentials as JSON" }, 415);
    }
    const email = await bodyEmail(c.req.raw);
    if (email === null) return options.auth.handler(c.req.raw); // Better Auth answers the bad body.
    if (!signInLimiter.acquire(email)) {
      return c.json({ code: "TOO_MANY_ATTEMPTS", message: "Too many failed sign-in attempts. Try again later." }, 429);
    }
    let outcome: "failure" | "success" | "other" = "other";
    try {
      const res = await options.auth.handler(c.req.raw);
      outcome = res.status === 401 ? "failure" : res.ok ? "success" : "other";
      return res;
    } finally {
      signInLimiter.release(email, outcome);
    }
  });

  // Contract routes: every request gets a principal (or null); routes guard with requireUser().
  app.use(`${API_BASE_PATH}/*`, resolvePrincipal([sessionSource(options.auth, { publicUrl: options.publicUrl })]));

  app.notFound((c) => c.json(fail("not_found", "Not found"), 404));
  app.onError((error, c) => {
    options.logger.error("request_failed", { method: c.req.method, path: c.req.path, ...errorFields(error) });
    return c.json(fail("internal", "Internal error"), 500);
  });
  return app;
}

/** The `email` of a JSON body, read from a clone so the handler still gets the stream. */
async function bodyEmail(request: Request): Promise<string | null> {
  try {
    const body: unknown = await request.clone().json();
    const email = (body as { email?: unknown } | null)?.email;
    return typeof email === "string" ? email : null;
  } catch {
    return null;
  }
}

async function pingDatabase(db: Database, timeoutMs: number): Promise<"up" | "down"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"down">((resolve) => {
    timer = setTimeout(() => resolve("down"), timeoutMs);
  });
  try {
    return await Promise.race([
      db.execute(sql`select 1`).then(
        () => "up" as const,
        () => "down" as const,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
