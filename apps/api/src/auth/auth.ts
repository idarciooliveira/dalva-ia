import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import type { Database } from "../db/client";
import { authAccounts, authSessions, authVerifications, users } from "../db/schema";
import { claimOwner } from "../domain/instance";
import { errorFields, type Logger } from "../log";

/** Mounted here by `createApp`; the web app reaches it on the same origin through the proxy. */
export const AUTH_BASE_PATH = "/api/auth";
/** Cookie names: `dalva.session_token`, `__Secure-dalva.session_token` over https. */
export const COOKIE_PREFIX = "dalva";

const DAY_SECONDS = 24 * 60 * 60;

export interface AuthOptions {
  db: Database;
  logger: Logger;
  /** Public origin (config `PUBLIC_URL`). https makes the cookies `Secure` (and `__Secure-` prefixed). */
  publicUrl: string;
  secret: string;
  /**
   * Header carrying the client's address, set by the proxy. Turns on Better
   * Auth's per-address rate limits (in memory; sign-in and sign-up: 3 per 10 s).
   * Without it they stay off: Better Auth would put every caller in one bucket.
   */
  clientIpHeader?: string;
}

/**
 * Email and password only, no email verification (there is no email delivery
 * yet; Convex Auth didn't verify either). Rules kept from Convex Auth's
 * Password provider and the web forms: password of at least 8 characters,
 * email validated as an email. Differences, both from Better Auth: emails are
 * stored and matched lowercase, and passwords are capped (Convex had no cap).
 */
export function createAuth(options: AuthOptions) {
  const secure = options.publicUrl.startsWith("https:");
  return betterAuth({
    appName: "DALVA",
    baseURL: options.publicUrl,
    basePath: AUTH_BASE_PATH,
    secret: options.secret,
    trustedOrigins: [options.publicUrl],
    database: drizzleAdapter(options.db, {
      provider: "pg",
      schema: { user: users, session: authSessions, account: authAccounts, verification: authVerifications },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      // Sign-up signs the user in, as Convex Auth did.
      autoSignIn: true,
      minPasswordLength: 8,
      // Bounds the hashing work; far above Better Auth's default 128 so no imported password is refused.
      maxPasswordLength: 1024,
    },
    session: {
      // Convex Auth's default lifetime. Sliding: renewed (at most daily) while in use.
      expiresIn: 30 * DAY_SECONDS,
      updateAge: DAY_SECONDS,
    },
    rateLimit: { enabled: options.clientIpHeader !== undefined, storage: "memory" },
    advanced: {
      // On Postgres, "uuid" leaves the id to the column default (uuidv7()).
      database: { generateId: "uuid" },
      // Only the proxy's header; Better Auth's default (x-forwarded-for) can be sent by the client.
      ipAddress: { ipAddressHeaders: options.clientIpHeader ? [options.clientIpHeader] : [] },
      cookiePrefix: COOKIE_PREFIX,
      // Explicit: Better Auth turns both off by default when NODE_ENV=test.
      disableCSRFCheck: false,
      disableOriginCheck: false,
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure, path: "/" },
    },
    telemetry: { enabled: false },
    // The first user to sign up owns the instance (Settings → Assistant). Without the stored owner the
    // earliest user still counts as it, so a failure here changes nothing.
    databaseHooks: {
      user: {
        create: {
          after: async () => {
            await claimOwner(options.db).catch((error: unknown) => options.logger.error("owner_claim_failed", errorFields(error)));
          },
        },
      },
    },
    // Unexpected errors (database down, ...) are rethrown to the app's error handler, which logs only
    // their name and SQLSTATE. Left to Better Auth, they would be printed whole, query parameters
    // (emails, hashes, session tokens) included. Its own 4xx errors still answer normally.
    onAPIError: { throw: true },
    logger: {
      level: "warn",
      log: (level, message) => {
        if (level === "error") {
          // Error messages can quote SQL and its parameters: keep only that one happened.
          options.logger.error("auth_error");
          return;
        }
        // Warnings are fixed strings ("Invalid password"), but some quote the email address.
        const text = message.replace(/[^\s@]+@[^\s@]+/g, "[email]");
        options.logger[level === "warn" ? "warn" : "info"]("auth_log", { detail: text });
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
