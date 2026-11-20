/**
 * Who is calling, with what permissions. `resolvePrincipal` runs once per
 * request (on `/api/v1/*`) and stores the result in the context; route guards
 * (`requireUser`) read it. Nothing downstream looks at cookies or headers.
 *
 * Sources, tried in order; the first one that recognises its credential decides:
 * - session cookie (this PR): a signed-in web user, full finance access.
 * - bearer user token (later): the agent acting for a user, with the token's
 *   scopes and channel identity.
 * - service key (later): the agent's own routes; no user.
 * A request that carries `Authorization` is never authenticated by cookie, so
 * a bad or unknown bearer credential can't fall back to a browser session.
 */
import { fail } from "@mpf/finance-contract";
import { isAPIError } from "better-auth/api";
import { getSessionCookie } from "better-auth/cookies";
import type { Context, MiddlewareHandler } from "hono";

import { type Auth, COOKIE_PREFIX } from "../auth/auth";

export type Scope = "finance:read" | "finance:write" | "agent:state";

export interface UserPrincipal {
  kind: "user";
  userId: string;
  scopes: readonly Scope[];
  /** How the caller proved who they are. */
  via: "session";
}

/** Grows a `ServicePrincipal` with the service key. */
export type Principal = UserPrincipal;

export type AppEnv = { Variables: { principal: Principal | null } };

export type SourceResult =
  /** This source's credential isn't on the request. */
  | { status: "absent" }
  | { status: "ok"; principal: Principal }
  /** The credential is there but wrong, forged, expired or revoked. */
  | { status: "invalid" };

/** One way to authenticate. May attach headers to the response (e.g. a renewed session cookie). */
export type PrincipalSource = (c: Context<AppEnv>) => Promise<SourceResult>;

export const SESSION_SCOPES: readonly Scope[] = ["finance:read", "finance:write"];

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Better Auth session cookie → user with full finance access.
 *
 * Writes must come from the app's own origin: SameSite=Lax still sends the
 * cookie on POSTs from sibling subdomains (same site), so a write whose
 * Origin is anything but `publicUrl` is refused. Browsers send Origin on every
 * cross-origin write; requests without one are not from another site's page.
 *
 * Renewed or cleared cookies are attached with `c.header`, so routes must
 * answer through the context (`c.json`, `c.body`): a raw `Response` drops them.
 */
export function sessionSource(auth: Auth, options: { publicUrl: string }): PrincipalSource {
  return async (c) => {
    if (c.req.header("authorization") !== undefined) return { status: "absent" };
    // Other cookies on the shared origin (theme, ...) are not a session.
    if (!getSessionCookie(c.req.raw.headers, { cookiePrefix: COOKIE_PREFIX })) return { status: "absent" };
    const origin = c.req.header("origin");
    if (!SAFE_METHODS.has(c.req.method) && origin !== undefined && origin !== options.publicUrl) return { status: "invalid" };

    let result;
    try {
      result = await auth.api.getSession({ headers: c.req.raw.headers, returnHeaders: true });
    } catch (error) {
      // A session that vanished mid-renewal (signed out concurrently) is just invalid; anything else is a 500.
      if (isAPIError(error) && error.statusCode === 401) return { status: "invalid" };
      throw error;
    }
    const { headers, response } = result;
    // Renewed or cleared session cookies go back to the browser with whatever the route answers.
    for (const cookie of headers.getSetCookie()) c.header("Set-Cookie", cookie, { append: true });
    if (!response) return { status: "invalid" };
    return { status: "ok", principal: { kind: "user", userId: response.user.id, scopes: SESSION_SCOPES, via: "session" } };
  };
}

/**
 * Resolve the caller and store it as `principal` (null when anonymous). Only
 * an invalid credential is answered here (401); anonymous requests go on, and
 * each route decides with a guard. Errors (e.g. the database is down) reach
 * the app's error handler as 500: never treated as anonymous.
 */
export function resolvePrincipal(sources: readonly PrincipalSource[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("principal", null);
    for (const source of sources) {
      const result = await source(c);
      if (result.status === "absent") continue;
      if (result.status === "invalid") return c.json(fail("unauthorized", "Invalid or expired credentials"), 401);
      c.set("principal", result.principal);
      break;
    }
    await next();
  };
}

/** Route guard: a user principal holding every scope in `scopes`. */
export function requireUser(...scopes: Scope[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (!principal || principal.kind !== "user") {
      return c.json(fail("unauthorized", "Authentication required"), 401);
    }
    const missing = scopes.filter((scope) => !principal.scopes.includes(scope));
    if (missing.length > 0) return c.json(fail("forbidden", `Missing scope: ${missing.join(" ")}`), 403);
    await next();
  };
}

/** The guarded caller. Call only behind `requireUser`. */
export function userPrincipal(c: Context<AppEnv>): UserPrincipal {
  const principal = c.get("principal");
  if (!principal || principal.kind !== "user") throw new Error("userPrincipal() used without requireUser()");
  return principal;
}
