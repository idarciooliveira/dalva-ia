/**
 * Better Auth tables (email and password). The JS keys are Better Auth's field
 * names, which its Drizzle adapter maps by; columns are snake_case like the
 * rest of the schema. Ids come from Postgres (`uuidv7()`): Better Auth runs
 * with `generateId: "uuid"`, which leaves them to the database on Postgres.
 */
import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => instant("created_at").notNull().defaultNow();
const updatedAt = () => instant("updated_at").notNull().defaultNow();

export const users = pgTable(
  "users",
  {
    id: id(),
    name: text("name").notNull(),
    /** Better Auth lowercases on sign-up and sign-in; the check keeps imported rows the same. */
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_key").on(t.email),
    check("users_email_lowercase", sql`${t.email} = lower(${t.email})`),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: id(),
    /** Opaque session token; the cookie carries it signed. */
    token: text("token").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: instant("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("auth_sessions_token_key").on(t.token), index("auth_sessions_user_id_idx").on(t.userId)],
);

/** Credentials per provider. Email and password: `provider_id = 'credential'`, `account_id` = user id, `password` = scrypt hash. */
export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: id(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: instant("access_token_expires_at"),
    refreshTokenExpiresAt: instant("refresh_token_expires_at"),
    scope: text("scope"),
    /** `<hex salt>:<hex key>`, scrypt N=16384 r=16 p=1 (the Convex Auth / Lucia format too). */
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("auth_accounts_user_id_idx").on(t.userId),
    uniqueIndex("auth_accounts_provider_id_account_id_key").on(t.providerId, t.accountId),
  ],
);

/** Short-lived tokens (email verification, password reset). Unused until those flows exist. */
export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: id(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: instant("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_verifications_identifier_idx").on(t.identifier)],
);
