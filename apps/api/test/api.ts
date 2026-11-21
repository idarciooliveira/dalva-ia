/**
 * Helpers for `/api/v1` tests: seed users and rows, mint tokens, and call the
 * app in-process through the contract's own client (so every success is
 * parsed with the route's response schema) or raw, for what the typed client
 * would refuse to send.
 */
import {
  API_BASE_PATH,
  AUTHORIZATION_HEADER,
  bearerAuthorization,
  createFinanceClient,
  createFinanceServiceClient,
  errorEnvelopeSchema,
  IDEMPOTENCY_KEY_HEADER,
  FinanceApiError,
  successEnvelope,
  type ErrorCode,
  type RouteDef,
  type TokenScope,
} from "@mpf/finance-contract";
import { eq } from "drizzle-orm";
import { expect } from "vitest";

import { TOKEN_SCOPES } from "../src/auth/tokens";
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
import { DomainError } from "../src/domain/errors";
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

/** The contract's client, calling `app` in-process with `token`. */
export function clientFor(app: TestApp, token: string) {
  return createFinanceClient({ baseUrl: "https://finance.test", getToken: () => token, fetch: inProcess(app) });
}

/** `fetch` that calls `app` in-process. */
function inProcess(app: TestApp): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return await app.request(`${url.pathname}${url.search}`, init);
  }) as typeof fetch;
}

/** The contract's service client (the agent's service key), calling `app` in-process. */
export function serviceClientFor(app: TestApp, serviceKey = TEST_SERVICE_KEY) {
  return createFinanceServiceClient({ baseUrl: "https://finance.test", getServiceKey: () => serviceKey, fetch: inProcess(app) });
}

export interface RawResponse {
  status: number;
  headers: Headers;
  body: { ok: boolean; data?: unknown; error?: { code: ErrorCode; message: string; details?: unknown } };
}

/** Raw HTTP call to `/api/v1${path}`. `token` becomes a bearer header, `cookie` a session cookie. */
export async function raw(
  app: TestApp,
  method: string,
  path: string,
  options: {
    token?: string;
    cookie?: string;
    body?: unknown;
    rawBody?: string;
    idempotencyKey?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers[AUTHORIZATION_HEADER] = bearerAuthorization(options.token);
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.idempotencyKey) headers[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey;
  let body: string | undefined = options.rawBody;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["Content-Type"] = "application/json";
  }
  const response = await app.request(`${API_BASE_PATH}${path}`, { method, headers, body });
  return { status: response.status, headers: response.headers, body: (await response.json()) as RawResponse["body"] };
}

/* Assertions --------------------------------------------------------------- */

/** A raw success response that conforms to the route's response schema; returns its `data`. */
export function expectConforms(route: RouteDef, response: RawResponse) {
  expect(response.status).toBe(200);
  const parsed = successEnvelope(route.response).safeParse(response.body);
  if (!parsed.success) throw new Error(`Contract violation: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.data.data;
}

/** A raw response that is the contract's error envelope with `code` and `status`. */
export function expectError(response: RawResponse, code: ErrorCode, status: number) {
  expect(errorEnvelopeSchema.safeParse(response.body).success).toBe(true);
  expect(response.body.error?.code).toBe(code);
  expect(response.status).toBe(status);
}

/** Await a client call that must fail with `code` (and `status`). */
export async function expectApiError(promise: Promise<unknown>, code: ErrorCode, status?: number): Promise<FinanceApiError> {
  const error = await promise.then(
    () => {
      throw new Error(`Expected ${code}, but the call succeeded`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FinanceApiError);
  const apiError = error as FinanceApiError;
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
