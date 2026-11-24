/**
 * Who is calling, with what permissions. `resolvePrincipal` runs once per
 * request (on `/api/v1/*`) and stores the result in the context; the contract
 * router (and `requireUser` on hand-written routes) reads it. Nothing
 * downstream looks at cookies or headers.
 *
 * Sources, tried in order; the first one that recognises its credential decides:
 * - service key: `Authorization: Bearer <FINANCE_API_SERVICE_KEY>`, the
 *   agent's own routes; no user. It must come first: it is a bearer credential
 *   too, and the user-token source rejects anything that isn't a valid token.
 * - bearer user token: the agent acting for a user, with the token's scopes
 *   and channel identity (`cid`).
 * - session cookie: a signed-in web user, full finance access.
 * A request that carries `Authorization` is never authenticated by cookie, so
 * a bad or unknown bearer credential can't fall back to a browser session.
 */
import { parseBearerToken, type TokenScope } from "@mpf/finance-contract";
import { isAPIError } from "better-auth/api";
import { getSessionCookie } from "better-auth/cookies";
import type { Context, MiddlewareHandler } from "hono";

import { type Auth, COOKIE_PREFIX } from "../auth/auth";
import type { ServiceKey } from "../auth/service-key";
import type { UserTokens } from "../auth/tokens";
import { isUuid } from "../db/ids";
import { errorResponse } from "./errors";

export type Scope = TokenScope;

export interface UserPrincipal {
  kind: "user";
  userId: string;
  scopes: readonly Scope[];
  /** How the caller proved who they are. */
  via: "session" | "token";
  /**
   * Tokens minted for a linked chat carry its identity. The router re-checks
   * it inside each request's transaction, so unlinking or switching to
   * read-only applies at once (see `channelTokenProblem`).
   */
  channelIdentityId?: string;
}

/** The chat agent with the service key: the service routes only, acting for no user. */
export interface ServicePrincipal {
  kind: "service";
}

export type Principal = UserPrincipal | ServicePrincipal;

export type AppEnv = { Variables: { principal: Principal | null } };

export type SourceResult =
  /** This source's credential isn't on the request. */
  | { status: "absent" }
  | { status: "ok"; principal: Principal }
  /** The credential is there but wrong, forged, expired or revoked. `message` is safe to send back. */
  | { status: "invalid"; message?: string };

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
 * `Authorization: Bearer <service key>` → the service principal. Any other
 * bearer value is `absent` here, so the user-token source judges it. Without a
 * configured key nothing matches, and the service routes answer 401.
 */
export function serviceKeySource(serviceKey: ServiceKey | undefined): PrincipalSource {
  return async (c) => {
    const header = c.req.header("authorization");
    if (!serviceKey || header === undefined) return { status: "absent" };
    const presented = parseBearerToken(header);
    if (!presented || !serviceKey.matches(presented)) return { status: "absent" };
    return { status: "ok", principal: { kind: "service" } };
  };
}

/**
 * `Authorization: Bearer <user token>` → the token's user, scopes and channel
 * identity. Tokens are HS256 JWTs (`../auth/tokens.ts`), minted for the chat
 * agent. The user isn't looked up: a token is only ever minted for a user
 * that exists, and users are never deleted.
 */
export function userTokenSource(tokens: UserTokens): PrincipalSource {
  return async (c) => {
    const header = c.req.header("authorization");
    if (header === undefined) return { status: "absent" };
    const token = parseBearerToken(header);
    if (!token) return { status: "invalid", message: "Missing bearer token" };
    const result = await tokens.verify(token);
    if (!result.ok) return { status: "invalid", message: result.reason === "expired" ? "Token expired" : "Invalid token" };
    const { sub, scopes, cid } = result.claims;
    // Ids are UUIDs here; anything else can't name a user or identity (and would fail the query).
    if (!isUuid(sub) || (cid !== undefined && !isUuid(cid))) return { status: "invalid", message: "Invalid token" };
    return {
      status: "ok",
      principal: { kind: "user", userId: sub, scopes, via: "token", ...(cid ? { channelIdentityId: cid } : {}) },
    };
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
    const result = await principalFrom(c, sources);
    if (result.status === "invalid") return errorResponse(c, "unauthorized", result.message ?? INVALID_CREDENTIALS);
    c.set("principal", result.status === "ok" ? result.principal : null);
    await next();
  };
}

export const INVALID_CREDENTIALS = "Invalid or expired credentials";

/** The first source that recognises its credential decides; `absent` when none does. Shared by `/api/v1` and `/api/trpc`. */
export async function principalFrom(c: Context<AppEnv>, sources: readonly PrincipalSource[]): Promise<SourceResult> {
  for (const source of sources) {
    const result = await source(c);
    if (result.status !== "absent") return result;
  }
  return { status: "absent" };
}

/** Route guard: a user principal holding every scope in `scopes`. */
export function requireUser(...scopes: Scope[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (!principal || principal.kind !== "user") return errorResponse(c, "unauthorized", "Authentication required");
    const missing = scopes.filter((scope) => !principal.scopes.includes(scope));
    if (missing.length > 0) return errorResponse(c, "forbidden", `Missing scope: ${missing.join(" ")}`);
    await next();
  };
}

/** The guarded caller. Call only behind `requireUser`. */
export function userPrincipal(c: Context<AppEnv>): UserPrincipal {
  const principal = c.get("principal");
  if (!principal || principal.kind !== "user") throw new Error("userPrincipal() used without requireUser()");
  return principal;
}
