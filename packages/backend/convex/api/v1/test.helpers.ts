/**
 * Shared helpers for Finance API tests. Not a Convex module (two dots in the
 * file name), never deployed.
 */
import {
  API_BASE_PATH,
  createFinanceClient,
  FinanceApiError,
  successEnvelope,
  type ErrorCode,
  type RouteDef,
} from "@mpf/finance-contract";
import { expect, vi } from "vitest";

import type { Doc, Id } from "../../_generated/dataModel";
import { setupTest } from "../../test.setup";
import { mintUserToken, TOKEN_SECRET_ENV, type FinanceScope } from "./tokens";

export const TEST_SECRET = "finance-api-test-secret-0123456789abcdef";
export const ALL_SCOPES: FinanceScope[] = ["finance:read", "finance:write"];

export type T = ReturnType<typeof setupTest>;

export function setupApi(): T {
  vi.stubEnv(TOKEN_SECRET_ENV, TEST_SECRET);
  return setupTest();
}

export async function seedUser(t: T, options: { baseCurrency?: string; profile?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    if (options.profile !== false) {
      await ctx.db.insert("userProfiles", {
        userId,
        baseCurrency: options.baseCurrency ?? "USD",
        onboardingCompleted: true,
      });
    }
    return userId as string;
  });
}

export async function seedAccount(
  t: T,
  userId: string,
  options: { name?: string; currency?: string; balance?: number; type?: Doc<"accounts">["type"] } = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("accounts", {
      userId,
      name: options.name ?? "Checking",
      type: options.type ?? "bank",
      balance: options.balance ?? 0,
      currency: options.currency ?? "USD",
    }),
  );
}

export async function seedCategory(t: T, userId: string, options: { name?: string; type?: "income" | "expense" } = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("categories", {
      userId,
      name: options.name ?? "Food",
      type: options.type ?? "expense",
      isDefault: false,
    }),
  );
}

export const getDoc = <TT extends "accounts" | "transactions" | "savingsGoals" | "debts" | "apiIdempotencyKeys">(
  t: T,
  id: Id<TT>,
) => t.run((ctx) => ctx.db.get(id));

export const tokenFor = (userId: string, scopes: FinanceScope[] = ALL_SCOPES, ttl = 600) =>
  mintUserToken(userId, scopes, ttl);

/** The contract's own client over `t.fetch`: every success is parsed with the route's response schema. */
export function clientFor(t: T, token: string) {
  return createFinanceClient({
    baseUrl: "https://finance.test",
    getToken: () => token,
    fetch: async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return await t.fetch(`${url.pathname}${url.search}`, init);
    },
  });
}

export interface RawResponse {
  status: number;
  headers: Headers;
  body: { ok: boolean; data?: unknown; error?: { code: ErrorCode; message: string; details?: unknown } };
}

/** Raw HTTP call, for what the typed client would refuse to send. */
export async function raw(
  t: T,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; rawBody?: string; idempotencyKey?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  let body: string | undefined = options.rawBody;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["Content-Type"] = "application/json";
  }
  const response = await t.fetch(`${API_BASE_PATH}${path}`, { method, headers, body });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

/** Assert a raw success response conforms to the route's contract response schema. */
export function expectConforms(route: RouteDef, response: RawResponse) {
  expect(response.status).toBe(200);
  const parsed = successEnvelope(route.response).safeParse(response.body);
  if (!parsed.success) throw new Error(`Contract violation: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.data.data;
}

/** Await a client call that must fail with `code`. */
export async function expectApiError(promise: Promise<unknown>, code: ErrorCode, status?: number) {
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

/** Two onboarded users with a USD account each, plus their clients. */
export async function twoUsers(t: T) {
  const alice = await seedUser(t);
  const bob = await seedUser(t);
  const aliceAccount = await seedAccount(t, alice, { balance: 100_000 });
  const bobAccount = await seedAccount(t, bob, { balance: 50_000 });
  return {
    alice,
    bob,
    aliceAccount,
    bobAccount,
    asAlice: clientFor(t, await tokenFor(alice)),
    asBob: clientFor(t, await tokenFor(bob)),
  };
}
