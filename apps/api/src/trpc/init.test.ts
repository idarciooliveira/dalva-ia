import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ALL_SCOPES,
  clientFor,
  expectApiError,
  expectError,
  getAccountRow,
  raw,
  seedAccount,
  seedChannelIdentity,
  seedUser,
  tokenFor,
} from "../../test/api";
import { TEST_PUBLIC_URL, TEST_SERVICE_KEY, TEST_TOKEN_SECRET, testApp, testTokens } from "../../test/app";
import { testDb } from "../../test/db";
import type { TokenScope } from "../auth/tokens";
import { accounts, agentInboundEvents } from "../db/schema";
import { conflict } from "../domain/errors";
import { agentWrite, commitThenFail, financeWrite, router, serviceWrite } from "./init";
import { appRouter } from "./router";

const KEY = "init-test-key-0001";

/**
 * Who may call each procedure. Every procedure must be listed: a new one
 * fails the first test until its access is decided here.
 * - finance: web app and chat agent (`finance:read` queries, `finance:write` mutations with an Idempotency-Key)
 * - web: web app only, same scopes and key
 * - webNoKey: web-only mutation without Idempotency-Key
 * - agent: agent store (`agent:state`, a token for a linked chat)
 * - service: the agent's service key
 */
type Access = "finance" | "web" | "webNoKey" | "agent" | "service";
const ACCESS: Record<string, Access> = {
  "accounts.list": "finance",
  "accounts.get": "finance",
  "accounts.adjust": "finance",
  "accounts.create": "web",
  "accounts.update": "web",
  "accounts.archive": "web",
  "accounts.restore": "web",
  "accounts.delete": "web",
  "profile.get": "web",
  "profile.create": "web",
  "profile.completeOnboarding": "web",
  "categories.list": "finance",
  "categories.defaults": "web",
  "categories.seedDefaults": "web",
  "categories.create": "web",
  "categories.update": "web",
  "categories.archive": "web",
  "categories.restore": "web",
  "categories.delete": "web",
  "subcategories.list": "finance",
  "subcategories.create": "web",
  "subcategories.update": "web",
  "subcategories.archive": "web",
  "subcategories.restore": "web",
  "subcategories.delete": "web",
  "transactions.search": "finance",
  "transactions.get": "finance",
  "transactions.create": "finance",
  "transactions.update": "finance",
  "transactions.delete": "finance",
  "transfers.get": "web",
  "transfers.create": "finance",
  "transfers.update": "finance",
  "transfers.delete": "finance",
  "reports.transactionSummary": "finance",
  "reports.spendingByCategory": "finance",
  "reports.cashflow": "finance",
  "reports.netWorth": "finance",
  "reports.debtSummary": "finance",
  "goals.list": "finance",
  "goals.get": "finance",
  "goals.create": "web",
  "goals.update": "web",
  "goals.archive": "web",
  "goals.restore": "web",
  "goals.delete": "web",
  "goalContributions.list": "finance",
  "goalContributions.add": "finance",
  "goalContributions.remove": "finance",
  "debts.list": "finance",
  "debts.get": "finance",
  "debts.create": "web",
  "debts.update": "web",
  "debts.archive": "web",
  "debts.restore": "web",
  "debts.delete": "web",
  "debtPayments.list": "finance",
  "debtPayments.record": "finance",
  "debtPayments.remove": "finance",
  "chatLinks.list": "web",
  "chatLinks.createCode": "webNoKey",
  "chatLinks.unlink": "webNoKey",
  "chatLinks.setReadOnly": "webNoKey",
  "chatHistory.delete": "webNoKey",
  "agentSessions.current": "agent",
  "agentMessages.list": "agent",
  "agentMessages.append": "agent",
  "agentPendingActions.create": "agent",
  "agentPendingActions.check": "agent",
  "agentPendingActions.get": "agent",
  "agentPendingActions.confirm": "agent",
  "agentPendingActions.cancel": "agent",
  "agentPendingActions.complete": "agent",
  "agentHistory.delete": "agent",
  "channelLinks.redeem": "service",
  "channelIdentities.resolve": "service",
  "channelIdentities.unlink": "service",
  "agentEvents.claim": "service",
  "agentEvents.updateStatus": "service",
  "agentEvents.listRecoverable": "service",
  "instance.get": "web",
  "instance.saveTelegram": "webNoKey",
  "instance.removeTelegram": "webNoKey",
  "instance.telegramStatus": "web",
  "instance.saveAi": "webNoKey",
  "instance.agentConfig": "service",
};

/** Service procedures without input: the service key alone gets an answer. */
const SERVICE_NO_INPUT = new Set(["instance.agentConfig"]);

const procedures = appRouter._def.procedures as unknown as Record<string, { _def: { type: "query" | "mutation" } }>;
const typeOf = (path: string) => procedures[path]!._def.type;
const requiredScope = (path: string): TokenScope =>
  ACCESS[path] === "agent" ? "agent:state" : typeOf(path) === "query" ? "finance:read" : "finance:write";
const needsKey = (path: string) => ["finance", "web"].includes(ACCESS[path]!) && typeOf(path) === "mutation";

/** Input that passes no schema (or none needed) and names nothing. */
const emptyInput = (path: string) => (typeOf(path) === "query" ? undefined : {});
const optionsFor = (path: string) => (needsKey(path) ? { idempotencyKey: KEY } : {});

async function forgedToken(userId: string) {
  const [h, p] = (await tokenFor(userId)).split(".");
  return `${h}.${p}.${"A".repeat(43)}`;
}

const userPaths = Object.keys(ACCESS).filter((p) => ACCESS[p] !== "service");
const servicePaths = Object.keys(ACCESS).filter((p) => ACCESS[p] === "service");
const webPaths = Object.keys(ACCESS).filter((p) => ACCESS[p] === "web" || ACCESS[p] === "webNoKey");

describe("procedure access", () => {
  it("classifies every procedure of the API", () => {
    expect(Object.keys(procedures).sort()).toEqual(Object.keys(ACCESS).sort());
  });

  describe.each(servicePaths)("%s (service)", (path) => {
    const input = emptyInput(path);

    it("rejects no credential, a wrong key and user tokens with 401", async () => {
      const { app } = testApp();
      const user = await seedUser();
      expectError(await raw(app, path, input), "unauthorized", 401);
      expectError(await raw(app, path, input, { token: "x".repeat(48) }), "unauthorized", 401);
      expectError(await raw(app, path, input, { token: TEST_SERVICE_KEY.slice(0, -1) }), "unauthorized", 401);
      for (const scopes of [["finance:read"], ALL_SCOPES] as const) {
        expectError(await raw(app, path, input, { token: await tokenFor(user, [...scopes]) }), "unauthorized", 401);
      }
      // The token secret is not the service key either.
      expectError(await raw(app, path, input, { token: TEST_TOKEN_SECRET }), "unauthorized", 401);
      expectError(await raw(app, path, input, { headers: { Authorization: `Basic ${TEST_SERVICE_KEY}` } }), "unauthorized", 401);
    });

    it("accepts the service key without an Idempotency-Key and validates the input", async () => {
      const { app } = testApp();
      const response = await raw(app, path, input, { token: TEST_SERVICE_KEY });
      if (SERVICE_NO_INPUT.has(path)) expect(response.status).toBe(200);
      else expectError(response, "validation_failed", 400);
    });

    it("answers 401 to every credential when no service key is configured", async () => {
      const { app } = testApp({ serviceKey: null });
      expectError(await raw(app, path, input, { token: TEST_SERVICE_KEY }), "unauthorized", 401);
    });
  });

  describe.each(userPaths)("%s (user)", (path) => {
    const input = emptyInput(path);
    const options = optionsFor(path);

    it("rejects a missing, malformed, forged or expired token with 401", async () => {
      const { app } = testApp();
      const user = await seedUser();
      const now = Math.floor(Date.now() / 1000);
      const expired = await testTokens.mint(user, ALL_SCOPES, 60, { now: now - 120 });

      const noToken = await raw(app, path, input, options);
      expectError(noToken, "unauthorized", 401);
      expect(noToken.headers.get("WWW-Authenticate")).toContain("Bearer");
      expectError(await raw(app, path, input, { ...options, headers: { Authorization: "Basic abc" } }), "unauthorized", 401);
      expectError(await raw(app, path, input, { ...options, token: "not.a.jwt" }), "unauthorized", 401);
      expectError(await raw(app, path, input, { ...options, token: await forgedToken(user) }), "unauthorized", 401);
      const expiredResponse = await raw(app, path, input, { ...options, token: expired });
      expectError(expiredResponse, "unauthorized", 401);
      expect(expiredResponse.body.error?.message).toBe("Token expired");
    });

    it("rejects a token without the required scope with 403", async () => {
      const { app } = testApp();
      const user = await seedUser();
      const required = requiredScope(path);
      const others = ALL_SCOPES.filter((scope) => scope !== required);
      for (const scopes of [[required === "finance:write" ? "finance:read" : "finance:write"], others] as const) {
        expectError(await raw(app, path, input, { ...options, token: await tokenFor(user, [...scopes]) }), "forbidden", 403);
      }
    });

    it("rejects the service key with 401", async () => {
      const { app } = testApp();
      expectError(await raw(app, path, input, { ...options, token: TEST_SERVICE_KEY }), "unauthorized", 401);
    });

    it("never 500s on unknown ids or empty input", async () => {
      const { app } = testApp();
      const user = await seedUser();
      // Agent-store procedures act for a linked chat; the rest for the plain user.
      const channelIdentityId = ACCESS[path] === "agent" ? await seedChannelIdentity(user) : undefined;
      const response = await raw(app, path, input, { ...options, token: await tokenFor(user, ALL_SCOPES, { channelIdentityId }) });
      expect([200, 400, 404]).toContain(response.status);
    });
  });

  it.each(webPaths)("%s refuses chat tokens", async (path) => {
    const { app } = testApp();
    const user = await seedUser();
    const token = await tokenFor(user, ALL_SCOPES, { channelIdentityId: await seedChannelIdentity(user) });
    const response = await raw(app, path, emptyInput(path), { ...optionsFor(path), token });
    expectError(response, "forbidden", 403);
    expect(response.body.error?.message).toBe("Not available to chat tokens");
  });
});

describe("transport", () => {
  it("answers not_found for unknown procedures and the wrong method", async () => {
    const { app } = testApp();
    const token = await tokenFor(await seedUser());
    expectError(await raw(app, "nope.list", undefined, { token, type: "query" }), "not_found", 404);
    expectError(await raw(app, "accounts.nope", {}, { token, idempotencyKey: KEY, type: "mutation" }), "not_found", 404);
    // A mutation over GET, a query over POST.
    expect((await raw(app, "accounts.delete", { id: "x" }, { token, type: "query" })).body.error?.code).toBe("not_found");
    expect((await raw(app, "accounts.list", {}, { token, type: "mutation" })).body.error?.code).toBe("not_found");
  });

  it("validates input and answers the issues", async () => {
    const { app } = testApp();
    const token = await tokenFor(await seedUser());
    const response = await raw(app, "accounts.list", { includeArchived: "maybe", unknown: 1 }, { token });
    expectError(response, "validation_failed", 400);
    expect(response.body.error?.message).toBe("Request validation failed");
    const paths = (response.body.error?.details as { issues: Array<{ path: string }> }).issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["includeArchived", ""]));
    expectError(await raw(app, "accounts.get", { id: "bad;id" }, { token }), "validation_failed", 400);
    // Ids are canonical lowercase UUIDs.
    const notUuid = await raw(app, "accounts.get", { id: "not-a-uuid" }, { token });
    expectError(notUuid, "validation_failed", 400);
    expect(notUuid.body.error?.details).toEqual({ issues: [{ path: "id", message: "Invalid id" }] });
    const account = await seedAccount(await seedUser());
    expectError(await raw(app, "accounts.get", { id: account.toUpperCase() }, { token }), "validation_failed", 400);
    // Unknown keys are refused, never ignored.
    expectError(await raw(app, "accounts.adjust", { id: account, amount: { amountMinor: 1, currency: "USD" }, extra: true }, { token, idempotencyKey: KEY }), "validation_failed", 400);
  });

  it("requires a valid Idempotency-Key on finance writes", async () => {
    const { app } = testApp();
    const token = await tokenFor(await seedUser());
    const input = { id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c", amount: { amountMinor: 1, currency: "USD" } };
    for (const idempotencyKey of [undefined, "short", "has spaces in it!"]) {
      const response = await raw(app, "accounts.adjust", input, { token, idempotencyKey });
      expectError(response, "validation_failed", 400);
      expect(response.body.error?.message).toContain("Idempotency-Key");
    }
  });

  it("rejects malformed, non-object and oversized JSON bodies", async () => {
    const { app } = testApp();
    const token = await tokenFor(await seedUser());
    const send = (rawBody: string) => raw(app, "accounts.create", undefined, { token, idempotencyKey: KEY, rawBody });
    expectError(await send("{nope"), "validation_failed", 400);
    expectError(await send("[1,2]"), "validation_failed", 400);
    expectError(await send("null"), "validation_failed", 400);
    const tooLarge = await send(JSON.stringify({ name: "x".repeat(70 * 1024) }));
    expectError(tooLarge, "validation_failed", 413);
    expect(tooLarge.body.error?.message).toBe("Request body too large");
  });

  it("stops reading a chunked body without Content-Length once it passes the limit", async () => {
    const { app } = testApp();
    const token = await tokenFor(await seedUser());
    let pulled = 0;
    const chunk = new TextEncoder().encode(`"${"x".repeat(16 * 1024)}",`);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled === 1) controller.enqueue(new TextEncoder().encode('{"name":['));
        else if (pulled < 1000) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const response = await app.request("/api/trpc/accounts.create", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": KEY, "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(20);
  });

  it("answers validation_failed for text Postgres can't store (NUL), and rolls back", async () => {
    const { app } = testApp();
    const user = await seedUser();
    const account = await seedAccount(user);
    const token = await tokenFor(user);
    const created = await raw(
      app,
      "accounts.create",
      { name: "a\u0000b", type: "bank", balance: { amountMinor: 0, currency: "USD" } },
      { token, idempotencyKey: "nul-key-0001" },
    );
    expectError(created, "validation_failed", 400);
    const adjusted = await raw(
      app,
      "accounts.adjust",
      { id: account, amount: { amountMinor: 1, currency: "USD" }, note: "x\u0000" },
      { token, idempotencyKey: "nul-key-0002" },
    );
    expectError(adjusted, "validation_failed", 400);
    expect(adjusted.body.error?.message).toBe("Text contains characters that can't be stored");
    expect((await getAccountRow(account))?.balance).toBe(0);
  });

  it("answers validation_failed for dates Postgres can't hold (year 0000), and rolls back", async () => {
    const { app } = testApp();
    const user = await seedUser();
    const account = await seedAccount(user);
    const token = await tokenFor(user);
    const adjusted = await raw(
      app,
      "accounts.adjust",
      { id: account, amount: { amountMinor: 1, currency: "USD" }, date: "0000-01-01" },
      { token, idempotencyKey: "date-key-0001" },
    );
    expectError(adjusted, "validation_failed", 400);
    expect(adjusted.body.error?.message).toBe("Date out of range");
    expect((await getAccountRow(account))?.balance).toBe(0);
    expectError(await raw(app, "transactions.search", { dateFrom: "0000-12-31" }, { token }), "validation_failed", 400);
    expectError(await raw(app, "reports.cashflow", { month: "0001-02", trendMonths: 3 }, { token }), "validation_failed", 400);
  });

  it("refuses a token whose subject or channel identity can't be an id", async () => {
    const { app } = testApp();
    for (const token of [
      await testTokens.mint("not-a-uuid", ALL_SCOPES, 600),
      await testTokens.mint((await seedUser()).toUpperCase(), ALL_SCOPES, 600),
      await testTokens.mint(await seedUser(), ALL_SCOPES, 600, { channelIdentityId: "ci-1" }),
    ]) {
      const response = await raw(app, "accounts.list", {}, { token });
      expectError(response, "unauthorized", 401);
      expect(response.body.error?.message).toBe("Invalid token");
    }
  });
});

describe("channel tokens (cid)", () => {
  it("serve the identity's user while it is linked", async () => {
    const { app } = testApp();
    const user = await seedUser();
    const account = await seedAccount(user, { balance: 100 });
    const identity = await seedChannelIdentity(user);
    const client = clientFor(app, await tokenFor(user, ALL_SCOPES, { channelIdentityId: identity }));
    expect((await client.accounts.list()).items.map((a) => a.id)).toEqual([account]);
    await client.accounts.adjust({ id: account, amount: { amountMinor: 1, currency: "USD" } });
    expect((await getAccountRow(account))?.balance).toBe(101);
  });

  it("stop at once when the identity is unlinked or belongs to someone else", async () => {
    const { app } = testApp();
    const user = await seedUser();
    const unlinked = await seedChannelIdentity(user, { unlinked: true });
    const foreign = await seedChannelIdentity(await seedUser());
    for (const channelIdentityId of [unlinked, foreign, "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c"]) {
      const client = clientFor(app, await tokenFor(user, ALL_SCOPES, { channelIdentityId }));
      const error = await expectApiError(client.accounts.list(), "unauthorized", 401);
      expect(error.message).toBe("Channel link revoked");
    }
  });

  it("can't write once the identity is read-only, whatever the token's scopes", async () => {
    const { app } = testApp();
    const user = await seedUser();
    const account = await seedAccount(user, { balance: 100 });
    const identity = await seedChannelIdentity(user, { readOnly: true });
    const client = clientFor(app, await tokenFor(user, ALL_SCOPES, { channelIdentityId: identity }));
    expect((await client.accounts.list()).items).toHaveLength(1);
    const error = await expectApiError(client.accounts.adjust({ id: account, amount: { amountMinor: 1, currency: "USD" } }), "forbidden", 403);
    expect(error.message).toBe("Channel link lacks the finance:write scope");
    expect((await getAccountRow(account))?.balance).toBe(100);
  });

  it("are required by the agent store", async () => {
    const { app } = testApp();
    const user = await seedUser();
    const plain = await raw(app, "agentHistory.delete", undefined, { token: await tokenFor(user) });
    expectError(plain, "forbidden", 403);
    expect(plain.body.error?.message).toBe("Agent routes need a token for a linked chat");
    const identity = await seedChannelIdentity(user, { readOnly: true });
    const chat = await raw(app, "agentHistory.delete", undefined, { token: await tokenFor(user, ["agent:state"], { channelIdentityId: identity }) });
    expect(chat.status).toBe(200);
  });
});

describe("commitThenFail", () => {
  const storeEvent = (tx: Parameters<Parameters<typeof agentWrite.mutation>[0]>[0]["ctx"]["tx"]) =>
    tx.insert(agentInboundEvents).values({ channel: "telegram", eventId: "kept", status: "received", payload: "{}", receivedAt: new Date(), updatedAt: new Date() });

  it("commits an agent-store write, then answers the error", async () => {
    const testRouter = router({
      fake: router({
        expire: agentWrite.input(z.object({}).optional()).mutation(async ({ ctx }) => {
          await storeEvent(ctx.tx);
          throw commitThenFail(conflict("Pending action expired", { status: "expired" }));
        }),
      }),
    });
    const { app } = testApp({ router: testRouter });
    const user = await seedUser();
    const token = await tokenFor(user, ["agent:state"], { channelIdentityId: await seedChannelIdentity(user) });
    const response = await raw(app, "fake.expire", {}, { token, type: "mutation" });
    expectError(response, "conflict", 409);
    expect(response.body.error).toEqual({ code: "conflict", message: "Pending action expired", details: { status: "expired" } });
    expect(await testDb().select().from(agentInboundEvents)).toHaveLength(1);
  });

  it("is a 500 in a finance write, and rolls back", async () => {
    const testRouter = router({
      fake: router({
        adjust: financeWrite.input(z.object({}).optional()).mutation(async ({ ctx }) => {
          await ctx.tx.update(accounts).set({ balance: 1 }).where(eq(accounts.userId, ctx.user.userId));
          throw commitThenFail(conflict("nope"));
        }),
      }),
    });
    const { app } = testApp({ router: testRouter });
    const user = await seedUser();
    const account = await seedAccount(user);
    const response = await raw(app, "fake.adjust", {}, { token: await tokenFor(user), idempotencyKey: KEY, type: "mutation" });
    expectError(response, "internal", 500);
    expect(response.body.error?.message).toBe("Internal error");
    expect((await getAccountRow(account))?.balance).toBe(0);
  });

  it("service writes run in a transaction: a failed write rolls back", async () => {
    const testRouter = router({
      fake: router({
        claim: serviceWrite.input(z.object({}).optional()).mutation(async ({ ctx }) => {
          await storeEvent(ctx.tx);
          throw conflict("after the write");
        }),
      }),
    });
    const { app } = testApp({ router: testRouter });
    const response = await raw(app, "fake.claim", {}, { token: TEST_SERVICE_KEY, type: "mutation" });
    expectError(response, "conflict", 409);
    expect(await testDb().select().from(agentInboundEvents)).toHaveLength(0);
  });
});

describe("session cookies (web)", () => {
  async function signedIn() {
    const { app } = testApp();
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_PUBLIC_URL },
      body: JSON.stringify({ name: "Ana", email: "ana@example.com", password: "correct horse battery" }),
    });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("dalva.session_token="))!.split(";")[0]!;
    return { app, cookie };
  }

  it("read and write with full finance access, Idempotency-Key included", async () => {
    const { app, cookie } = await signedIn();
    expect((await raw(app, "profile.create", { baseCurrency: "AOA" }, { cookie, idempotencyKey: KEY })).status).toBe(200);
    const account = await raw(
      app,
      "accounts.create",
      { name: "Banco", type: "bank", balance: { amountMinor: 5_000, currency: "AOA" } },
      { cookie, idempotencyKey: "init-test-key-0003" },
    );
    expect(account.status).toBe(200);
    const listed = await raw(app, "accounts.list", {}, { cookie });
    expect((listed.body.data as { items: unknown[] }).items).toHaveLength(1);
    expectError(await raw(app, "profile.completeOnboarding", {}, { cookie }), "validation_failed", 400);
  });

  it("are not tried when an Authorization header is present", async () => {
    const { app, cookie } = await signedIn();
    expectError(await raw(app, "accounts.list", {}, { cookie, token: "not.a.jwt" }), "unauthorized", 401);
  });

  it("refuse writes from another origin", async () => {
    const { app, cookie } = await signedIn();
    const response = await raw(app, "profile.create", { baseCurrency: "AOA" }, { cookie, idempotencyKey: KEY, headers: { origin: "https://evil.example" } });
    expectError(response, "unauthorized", 401);
  });
});
