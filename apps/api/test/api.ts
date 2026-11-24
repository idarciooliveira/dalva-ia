/**
 * Helpers for API tests: seed users and rows, mint tokens, and call the app
 * in-process through a tRPC client (`clientFor(app, token).group.op(input)`)
 * or raw, for what the typed client would refuse to send.
 */
import { randomUUID } from "node:crypto";

import { createTRPCUntypedClient, httpLink, TRPCClientError } from "@trpc/client";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { eq } from "drizzle-orm";
import { expect } from "vitest";

import { TOKEN_SCOPES, type TokenScope } from "../src/auth/tokens";
import {
  accounts,
  categories,
  channelIdentities,
  debtPayments,
  debts,
  goalContributions,
  savingsGoals,
  subcategories,
  transactions,
  userProfiles,
  users,
} from "../src/db/schema";
import { DomainError, type ErrorCode } from "../src/domain/errors";
import { type AppRouter, appRouter } from "../src/trpc/router";
import { createTestUser, TEST_SERVICE_KEY, testApp, testTokens } from "./app";
import { testDb } from "./db";

export type TestApp = ReturnType<typeof testApp>["app"];

export const ALL_SCOPES: TokenScope[] = [...TOKEN_SCOPES];

/* Seeding ------------------------------------------------------------------ */

/** A user, onboarded with a profile in `baseCurrency` (default USD) unless `profile: false`. */
export async function seedUser(options: { baseCurrency?: string; profile?: boolean } = {}): Promise<string> {
  const userId = await createTestUser();
  if (options.profile !== false) {
    await testDb()
      .insert(userProfiles)
      .values({ userId, baseCurrency: options.baseCurrency ?? "USD", onboardingCompleted: true });
  }
  return userId;
}

/** `balance` is stored minor units (value × 100). */
export async function seedAccount(
  userId: string,
  options: { name?: string; currency?: string; balance?: number; type?: (typeof accounts.$inferInsert)["type"]; archived?: boolean } = {},
): Promise<string> {
  const [row] = await testDb()
    .insert(accounts)
    .values({
      userId,
      name: options.name ?? "Checking",
      type: options.type ?? "bank",
      balance: options.balance ?? 0,
      currency: options.currency ?? "USD",
      archived: options.archived ?? false,
    })
    .returning({ id: accounts.id });
  return row!.id;
}

/** A linked Telegram identity, as the agent's link flow leaves it. */
export async function seedChannelIdentity(userId: string, options: { readOnly?: boolean; unlinked?: boolean } = {}) {
  const now = new Date();
  const [row] = await testDb()
    .insert(channelIdentities)
    .values({
      userId,
      channel: "telegram",
      externalUserId: String(Math.floor(Math.random() * 1e9)),
      chatId: "1",
      scopes: options.readOnly ? ["finance:read"] : ["finance:read", "finance:write"],
      linkedAt: now,
      consentAt: now,
      unlinkedAt: options.unlinked ? now : null,
    })
    .returning({ id: channelIdentities.id });
  return row!.id;
}

export async function seedCategory(userId: string, options: { name?: string; type?: "income" | "expense" } = {}): Promise<string> {
  const [row] = await testDb()
    .insert(categories)
    .values({ userId, name: options.name ?? "Food", type: options.type ?? "expense" })
    .returning({ id: categories.id });
  return row!.id;
}

export async function seedSubcategory(userId: string, categoryId: string, name = "Sub"): Promise<string> {
  const [row] = await testDb()
    .insert(subcategories)
    .values({ userId, categoryId, name, sortOrder: 0 })
    .returning({ id: subcategories.id });
  return row!.id;
}

/**
 * A transaction row as stored, without touching any balance (seeding, legacy
 * rows). `accountId: null` is a legacy orphan whose account Convex deleted.
 */
export async function seedTransaction(
  userId: string,
  accountId: string | null,
  fields: Partial<Omit<typeof transactions.$inferInsert, "userId" | "accountId">> = {},
): Promise<string> {
  const [row] = await testDb()
    .insert(transactions)
    .values({ type: "expense", amount: 100, date: "2026-03-01", ...fields, userId, accountId })
    .returning({ id: transactions.id });
  return row!.id;
}

export async function seedDebt(
  userId: string,
  fields: Partial<Omit<typeof debts.$inferInsert, "userId">> = {},
): Promise<string> {
  const [row] = await testDb()
    .insert(debts)
    .values({ name: "Loan", debtType: "loan", originalAmount: 10_000, currentBalance: 10_000, ...fields, userId })
    .returning({ id: debts.id });
  return row!.id;
}

/**
 * A debt payment as the debt flow records it: an expense on the paying
 * account plus, when the debt has a linked account, an adjustment on it.
 * Rows only, no balances.
 */
export async function seedDebtPayment(
  userId: string,
  args: { debtId: string; fromAccountId: string | null; amount?: number; date?: string; liabilityAccountId?: string },
) {
  const amount = args.amount ?? 500;
  const date = args.date ?? "2026-01-02";
  const sourceTransactionId = await seedTransaction(userId, args.fromAccountId, { type: "expense", amount, date });
  const liabilityTransactionId = args.liabilityAccountId
    ? await seedTransaction(userId, args.liabilityAccountId, { type: "adjustment", amount, date })
    : null;
  const [row] = await testDb()
    .insert(debtPayments)
    .values({
      userId,
      debtId: args.debtId,
      amount,
      principalAmount: amount,
      interestAmount: 0,
      date,
      fromAccountId: args.fromAccountId,
      sourceTransactionId,
      liabilityTransactionId,
    })
    .returning({ id: debtPayments.id });
  return { id: row!.id, sourceTransactionId, liabilityTransactionId };
}

/** A goal contribution owning the transfer whose outgoing leg is `transactionId`. */
export async function seedContribution(userId: string, transactionId: string, linkedAccountId: string): Promise<string> {
  const [goal] = await testDb()
    .insert(savingsGoals)
    .values({ userId, name: "Trip", targetAmount: 10_000, isVirtual: false, linkedAccountId })
    .returning({ id: savingsGoals.id });
  const [row] = await testDb()
    .insert(goalContributions)
    .values({ userId, goalId: goal!.id, amount: 500, date: "2026-01-02", transactionId })
    .returning({ id: goalContributions.id });
  return row!.id;
}

export async function getTransactionRow(id: string) {
  const [row] = await testDb().select().from(transactions).where(eq(transactions.id, id));
  return row;
}

export const balanceOf = async (accountId: string) => (await getAccountRow(accountId))?.balance;

/** A domain call that must fail with a `DomainError`: its code and message. */
export async function domainRejection(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  return { code: (error as DomainError).code, message: (error as DomainError).message };
}

export async function getAccountRow(id: string) {
  const [row] = await testDb().select().from(accounts).where(eq(accounts.id, id));
  return row;
}

export const transactionRows = () => testDb().select().from(transactions);

/* Credentials and clients -------------------------------------------------- */

export const tokenFor = (userId: string, scopes: TokenScope[] = ALL_SCOPES, options: { ttl?: number; channelIdentityId?: string } = {}) =>
  testTokens.mint(userId, scopes, options.ttl ?? 600, { channelIdentityId: options.channelIdentityId });

/** A failed call, in the API's error vocabulary (`error.data.apiCode`). */
export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Inputs = inferRouterInputs<AppRouter>;
type Outputs = inferRouterOutputs<AppRouter>;
export interface CallOptions {
  idempotencyKey?: string;
}
/** `client.transactions.create(input)`: every procedure as one function, query or mutation. */
export type ApiClient = {
  [G in keyof Inputs]: {
    [O in keyof Inputs[G]]: undefined extends Inputs[G][O]
      ? (input?: Inputs[G][O], options?: CallOptions) => Promise<Outputs[G][O]>
      : (input: Inputs[G][O], options?: CallOptions) => Promise<Outputs[G][O]>;
  };
};

const procedures = appRouter._def.procedures as unknown as Record<string, { _def: { type: "query" | "mutation" | "subscription" } }>;

function typeOf(path: string): "query" | "mutation" {
  const procedure = procedures[path];
  return procedure?._def.type === "query" ? "query" : "mutation";
}

/** `fetch` that calls `app` in-process. */
export function inProcess(app: TestApp): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return await app.request(`${url.pathname}${url.search}`, init);
  }) as typeof fetch;
}

function toApiError(error: unknown): unknown {
  if (!(error instanceof TRPCClientError)) return error;
  const data = error.data as { apiCode?: ErrorCode; httpStatus?: number; details?: unknown } | undefined;
  return new ApiError(data?.apiCode ?? "internal", error.message, data?.httpStatus ?? 0, data?.details);
}

/** A client calling `app` in-process with `Authorization: Bearer <credential>` (a user token or the service key). */
function clientWith(app: TestApp, credential: string): ApiClient {
  const client = createTRPCUntypedClient<AppRouter>({
    links: [
      httpLink({
        url: "https://finance.test/api/trpc",
        fetch: inProcess(app),
        headers: ({ op }) => {
          const key = op.context.idempotencyKey as string | undefined;
          return { authorization: `Bearer ${credential}`, ...(op.type === "mutation" ? { "idempotency-key": key ?? randomUUID() } : {}) };
        },
      }),
    ],
  });
  return new Proxy({} as ApiClient, {
    get: (_target, group: string) =>
      new Proxy(
        {},
        {
          get: (_inner, op: string) => async (input?: unknown, options: CallOptions = {}) => {
            const path = `${group}.${op}`;
            const context = options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {};
            try {
              return typeOf(path) === "query" ? await client.query(path, input, { context }) : await client.mutation(path, input, { context });
            } catch (error) {
              throw toApiError(error);
            }
          },
        },
      ),
  });
}

/** The user's client, calling `app` in-process with `token`. */
export const clientFor = (app: TestApp, token: string) => clientWith(app, token);

/** The agent's service-key client, calling `app` in-process. */
export const serviceClientFor = (app: TestApp, serviceKey = TEST_SERVICE_KEY) => clientWith(app, serviceKey);

export interface RawResponse {
  status: number;
  headers: Headers;
  /** The tRPC answer as `{ ok, data }` / `{ ok: false, error: { code, message, details } }` (`code` is `apiCode`). */
  body: { ok: boolean; data?: unknown; error?: { code: ErrorCode; message: string; details?: unknown } };
}

/**
 * Raw HTTP call to `/api/trpc/<path>`: GET with `?input=` for queries, POST
 * with a JSON body for mutations (`type` overrides it, for procedures of a
 * test router). `token` becomes a bearer header, `cookie` a session cookie.
 */
export async function raw(
  app: TestApp,
  path: string,
  input?: unknown,
  options: {
    token?: string;
    cookie?: string;
    rawBody?: string;
    idempotencyKey?: string;
    headers?: Record<string, string>;
    type?: "query" | "mutation";
  } = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  const type = options.type ?? typeOf(path);
  let response: Response;
  if (type === "query") {
    const query = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    response = await app.request(`/api/trpc/${path}${query}`, { headers });
  } else {
    headers["content-type"] = "application/json";
    const body = options.rawBody ?? (input === undefined ? undefined : JSON.stringify(input));
    response = await app.request(`/api/trpc/${path}`, { method: "POST", headers, body });
  }
  const json = (await response.json()) as { result?: { data: unknown }; error?: { message: string; data?: { apiCode: ErrorCode; details?: unknown } } };
  const body: RawResponse["body"] = json.error
    ? {
        ok: false,
        error: {
          code: json.error.data?.apiCode ?? "internal",
          message: json.error.message,
          ...(json.error.data?.details === undefined ? {} : { details: json.error.data.details }),
        },
      }
    : { ok: true, data: json.result?.data };
  return { status: response.status, headers: response.headers, body };
}

/* Assertions --------------------------------------------------------------- */

/** A raw success; returns its `data`. */
export function expectOk(response: RawResponse) {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.ok).toBe(true);
  return response.body.data;
}

/** A raw failure with `code` and `status`. */
export function expectError(response: RawResponse, code: ErrorCode, status: number) {
  expect(response.body.ok).toBe(false);
  expect(response.body.error?.code).toBe(code);
  expect(response.status).toBe(status);
}

/** Await a client call that must fail with `code` (and `status`). */
export async function expectApiError(promise: Promise<unknown>, code: ErrorCode, status?: number): Promise<ApiError> {
  const error = await promise.then(
    () => {
      throw new Error(`Expected ${code}, but the call succeeded`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  const apiError = error as ApiError;
  expect({ code: apiError.code, message: apiError.message }).toMatchObject({ code });
  if (status !== undefined) expect(apiError.status).toBe(status);
  return apiError;
}

/* Fixtures ----------------------------------------------------------------- */

/** One user (onboarded unless `profile: false`), the app and the user's client. */
export async function oneUser(options: { baseCurrency?: string; profile?: boolean } = {}) {
  const { app } = testApp();
  const user = await seedUser(options);
  return { app, user, client: clientFor(app, await tokenFor(user)) };
}

/** Two onboarded users with a USD account each (1000.00 and 500.00), plus the app and their clients. */
export async function twoUsers(app: TestApp = testApp().app) {
  const alice = await seedUser();
  const bob = await seedUser();
  const aliceAccount = await seedAccount(alice, { balance: 100_000 });
  const bobAccount = await seedAccount(bob, { balance: 50_000 });
  return {
    app,
    alice,
    bob,
    aliceAccount,
    bobAccount,
    asAlice: clientFor(app, await tokenFor(alice)),
    asBob: clientFor(app, await tokenFor(bob)),
  };
}

const TG = "telegram" as const;

/**
 * A user linked to a Telegram chat the way the bot does it (web code, service
 * redeem), plus the token `resolve` hands out: the one the agent uses on the
 * agent-store and finance routes. `web` is the user's own client (no chat
 * identity), for the web-only routes.
 */
export async function linkedChat(
  app: TestApp,
  options: { externalUserId?: string; readOnly?: boolean; withAccount?: boolean; name?: string; baseCurrency?: string } = {},
) {
  const externalUserId = options.externalUserId ?? "1001";
  const userId = await seedUser({ baseCurrency: options.baseCurrency });
  if (options.name) await testDb().update(users).set({ name: options.name }).where(eq(users.id, userId));
  const web = clientFor(app, await tokenFor(userId));
  const service = serviceClientFor(app);
  const chat = { channel: TG, externalUserId, chatId: externalUserId };
  const { code } = await web.chatLinks.createCode({ channel: TG, consent: true });
  const { identity } = await service.channelLinks.redeem({ ...chat, code });
  if (options.readOnly) await web.chatLinks.setReadOnly({ id: identity.id, readOnly: true });
  const resolved = await service.channelIdentities.resolve(chat);
  const client = clientFor(app, resolved.token);
  return {
    userId,
    web,
    service,
    chat,
    chatId: externalUserId,
    identityId: identity.id as string,
    token: resolved.token,
    resolved,
    agent: client,
    finance: client,
    accountId: options.withAccount ? await seedAccount(userId, { balance: 100_000 }) : undefined,
  };
}

export type LinkedChat = Awaited<ReturnType<typeof linkedChat>>;

/** Flat, valid input for `transactions.create`, for pending actions. */
export const expenseInput = (accountId: string, amountMinor = 1250) => ({
  type: "expense",
  amount: { amountMinor, currency: "USD" },
  accountId,
  date: "2026-04-05",
});
