import {
  allRoutes,
  isWriteRoute,
  requiredScope,
  requiresIdempotencyKey,
  type RouteDef,
  routes,
} from "@mpf/finance-contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  ALL_SCOPES,
  clientFor,
  expectApiError,
  expectError,
  getAccountRow,
  raw,
  type RawResponse,
  seedAccount,
  seedChannelIdentity,
  seedUser,
  tokenFor,
} from "../../test/api";
import { TEST_SERVICE_KEY, TEST_TOKEN_SECRET, testApp, testTokens, TEST_PUBLIC_URL } from "../../test/app";
import { testDb } from "../../test/db";
import { accounts, agentInboundEvents } from "../db/schema";
import { conflict } from "../domain/errors";
import { BodyTooLargeError, readBodyText } from "./router";
import { commitThenFail, operation, operationFor, serviceOperation, serviceOperationFor } from "./operation";
import { operations, serviceOperations } from "./v1";

const KEY = "router-test-key-0001";
/** A valid-looking path for a route; ids don't need to exist for auth checks. */
const pathOf = (path: string) => path.replace(/:(\w+)/g, "missing");

async function forgedToken(userId: string) {
  const [h, p] = (await tokenFor(userId)).split(".");
  return `${h}.${p}.${"A".repeat(43)}`;
}

const implemented = allRoutes().filter(
  (r) => operationFor(operations, r.group, r.op) !== null || serviceOperationFor(serviceOperations, r.group, r.op) !== null,
);
const userRoutes = implemented.filter((r) => r.route.auth === "user");
const serviceRoutes = implemented.filter((r) => r.route.auth === "service");
const optionsFor = (route: RouteDef) =>
  requiresIdempotencyKey(route) ? { idempotencyKey: KEY, body: {} } : isWriteRoute(route) ? { body: {} } : {};

describe("api/v1 router", () => {
  it("implements whole contract groups, each operation bound to its own route and credential", () => {
    const groups = new Set(implemented.map((r) => r.group));
    expect([...groups].sort()).toEqual([
      "accounts",
      "agentEvents",
      "agentHistory",
      "agentMessages",
      "agentPendingActions",
      "agentSessions",
      "channelIdentities",
      "channelLinks",
      "chatHistory",
      "chatLinks",
      "profile",
    ]);
    for (const { group, op, route } of allRoutes()) {
      const user = operationFor(operations, group, op);
      const service = serviceOperationFor(serviceOperations, group, op);
      if (!groups.has(group)) {
        expect([user, service], `${group}.${op}`).toEqual([null, null]);
        continue;
      }
      expect((route.auth === "user" ? user : service)?.route, `${group}.${op}`).toBe(route);
      expect(route.auth === "user" ? service : user, `${group}.${op}`).toBeNull();
    }
  });

  describe.each(serviceRoutes.map((r) => [r.name, r] as const))("%s service auth", (_name, { route }) => {
    const path = pathOf(route.path);
    const body = isWriteRoute(route) ? { body: {} } : {};

    it("rejects no credential, a wrong key and user tokens with 401", async () => {
      const { app } = testApp();
      const user = await seedUser();
      expectError(await raw(app, route.method, path, body), "unauthorized", 401);
      expectError(await raw(app, route.method, path, { ...body, token: "x".repeat(48) }), "unauthorized", 401);
      expectError(await raw(app, route.method, path, { ...body, token: TEST_SERVICE_KEY.slice(0, -1) }), "unauthorized", 401);
      for (const scopes of [["finance:read"], ALL_SCOPES] as const) {
        expectError(await raw(app, route.method, path, { ...body, token: await tokenFor(user, [...scopes]) }), "unauthorized", 401);
      }
      // The token secret is not the service key either.
      expectError(await raw(app, route.method, path, { ...body, token: TEST_TOKEN_SECRET }), "unauthorized", 401);
      expectError(await raw(app, route.method, path, { ...body, headers: { Authorization: `Basic ${TEST_SERVICE_KEY}` } }), "unauthorized", 401);
    });

    it("accepts the service key without an Idempotency-Key and validates the input", async () => {
      const { app } = testApp();
      expectError(await raw(app, route.method, path, { ...body, token: TEST_SERVICE_KEY }), "validation_failed", 400);
    });

    it("answers 401 to every credential when no service key is configured", async () => {
      const { app } = testApp({ serviceKey: null });
      expectError(await raw(app, route.method, path, { ...body, token: TEST_SERVICE_KEY }), "unauthorized", 401);
    });
  });

  describe.each(userRoutes.map((r) => [r.name, r] as const))("%s auth", (_name, { route }) => {
    const path = pathOf(route.path);
    const options = optionsFor(route);

    it("rejects a missing, malformed, forged or expired token with 401", async () => {
      const { app } = testApp();
      const user = await seedUser();
      const now = Math.floor(Date.now() / 1000);
      const expired = await testTokens.mint(user, ["finance:read", "finance:write"], 60, { now: now - 120 });

      const noToken = await raw(app, route.method, path, options);
      expectError(noToken, "unauthorized", 401);
      expect(noToken.headers.get("WWW-Authenticate")).toContain("Bearer");
      expectError(await raw(app, route.method, path, { ...options, headers: { Authorization: "Basic abc" } }), "unauthorized", 401);
      expectError(await raw(app, route.method, path, { ...options, token: "not.a.jwt" }), "unauthorized", 401);
      expectError(await raw(app, route.method, path, { ...options, token: await forgedToken(user) }), "unauthorized", 401);
      const expiredResponse = await raw(app, route.method, path, { ...options, token: expired });
      expectError(expiredResponse, "unauthorized", 401);
      expect(expiredResponse.body.error?.message).toBe("Token expired");
    });

    it("rejects a token without the required scope with 403", async () => {
      const { app } = testApp();
      const user = await seedUser();
      const required = requiredScope(route);
      const others = ALL_SCOPES.filter((scope) => scope !== required);
      for (const scopes of [[required === "finance:write" ? "finance:read" : "finance:write"], others] as const) {
        const wrongScope = await tokenFor(user, [...scopes]);
        expectError(await raw(app, route.method, path, { ...options, token: wrongScope }), "forbidden", 403);
      }
    });

    it("rejects the service key with 401", async () => {
      const { app } = testApp();
      expectError(await raw(app, route.method, path, { ...options, token: TEST_SERVICE_KEY }), "unauthorized", 401);
    });

    it("never 500s on unknown ids or empty input", async () => {
      const { app } = testApp();
      const user = await seedUser();
      // Agent-store routes act for a linked chat; the rest for the plain user.
      const channelIdentityId = route.scope ? await seedChannelIdentity(user) : undefined;
      const response = await raw(app, route.method, path, { ...options, token: await tokenFor(user, ALL_SCOPES, { channelIdentityId }) });
      expect([200, 400, 404]).toContain(response.status);
    });
  });

  it("answers not_found for contract routes not ported yet, after authenticating", async () => {
    const { app } = testApp();
    const token = await tokenFor(await seedUser());
    expectError(await raw(app, "GET", "/transactions"), "unauthorized", 401);
    expectError(await raw(app, "GET", "/transactions", { token }), "not_found", 404);
    expectError(await raw(app, "POST", "/transfers", { token, idempotencyKey: KEY, body: {} }), "not_found", 404);
  });

  it("returns not_found for unknown routes and methods", async () => {
    const { app } = testApp();
    const token = await tokenFor(await seedUser());
    expectError(await raw(app, "GET", "/nope", { token }), "not_found", 404);
    expectError(await raw(app, "DELETE", "/accounts", { token, idempotencyKey: KEY }), "not_found", 404);
    expectError(await raw(app, "GET", "/accounts/a/b", { token }), "not_found", 404);
    expectError(await raw(app, "GET", "//accounts", { token }), "not_found", 404);
  });

  it("validates query params and returns contract validation details", async () => {
    const { app } = testApp();
    const token = await tokenFor(await seedUser());
    const response = await raw(app, "GET", "/accounts?includeArchived=maybe&unknown=1", { token });
    expectError(response, "validation_failed", 400);
    const paths = (response.body.error?.details as { issues: Array<{ path: string }> }).issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["includeArchived", ""]));
    expectError(await raw(app, "GET", "/accounts/bad%3Bid", { token }), "validation_failed", 400);
    // Contract-valid but not a row id; ids are canonical lowercase UUIDs.
    const notUuid = await raw(app, "GET", "/accounts/not-a-uuid", { token });
    expectError(notUuid, "validation_failed", 400);
    expect(notUuid.body.error?.details).toEqual({ issues: [{ path: "id", message: "Invalid id" }] });
    const account = await seedAccount(await seedUser());
    expectError(await raw(app, "GET", `/accounts/${account.toUpperCase()}`, { token }), "validation_failed", 400);
  });

  it("requires a valid Idempotency-Key on writes", async () => {
    const { app } = testApp();
    const token = await tokenFor(await seedUser());
    const body = { amount: { amountMinor: 1, currency: "USD" } };
    for (const idempotencyKey of [undefined, "short", "has spaces in it!"]) {
      const response = await raw(app, "POST", "/accounts/missing/adjustments", { token, body, idempotencyKey });
      expectError(response, "validation_failed", 400);
      expect(response.body.error?.message).toContain("Idempotency-Key");
    }
  });

  it("rejects malformed, non-object and oversized JSON bodies", async () => {
    const { app } = testApp();
    const token = await tokenFor(await seedUser());
    const send = (rawBody: string) =>
      raw(app, "POST", "/accounts", { token, idempotencyKey: KEY, rawBody, headers: { "Content-Type": "application/json" } });
    expectError(await send("{nope"), "validation_failed", 400);
    expectError(await send("[1,2]"), "validation_failed", 400);
    expectError(await send("null"), "validation_failed", 400);
    const tooLarge = await send(JSON.stringify({ name: "x".repeat(70 * 1024) }));
    expectError(tooLarge, "validation_failed", 400);
    expect(tooLarge.body.error?.message).toBe("Request body too large");
  });

  it("stops reading a chunked body without Content-Length once it passes the limit", async () => {
    const { app } = testApp();
    const token = await tokenFor(await seedUser());
    let pulled = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode(`"${"x".repeat(16 * 1024)}",`);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled === 1) controller.enqueue(new TextEncoder().encode('{"name":['));
        else if (pulled < 1000) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await app.request("/api/v1/accounts", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": KEY, "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(400);
    expect(((await response.json()) as RawResponse["body"]).error?.message).toBe("Request body too large");
    expect(pulled).toBeLessThan(20);
    expect(cancelled).toBe(true);
  });

  it("readBodyText: reads small bodies and cancels past the limit", async () => {
    const stream = (parts: string[], onCancel?: () => void) => {
      const queue = [...parts];
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const part = queue.shift();
          if (part === undefined) controller.close();
          else controller.enqueue(new TextEncoder().encode(part));
        },
        cancel: onCancel,
      });
    };
    expect(await readBodyText(null, 10)).toBe("");
    expect(await readBodyText(stream(['{"a":', '"é"}']), 64)).toBe('{"a":"é"}');
    expect(await readBodyText(stream(["12345", "67890"]), 10)).toBe("1234567890");
    let cancelled = false;
    await expect(readBodyText(stream(["12345", "678901"], () => (cancelled = true)), 10)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancelled).toBe(true);
  });

  it("answers validation_failed for text Postgres can't store (NUL), and rolls back", async () => {
    const { app } = testApp();
    const user = await seedUser();
    const account = await seedAccount(user);
    const token = await tokenFor(user);
    const created = await raw(app, "POST", "/accounts", {
      token,
      idempotencyKey: "nul-key-0001",
      body: { name: "a\u0000b", type: "bank", balance: { amountMinor: 0, currency: "USD" } },
    });
    expectError(created, "validation_failed", 400);
    const adjusted = await raw(app, "POST", `/accounts/${account}/adjustments`, {
      token,
      idempotencyKey: "nul-key-0002",
      body: { amount: { amountMinor: 1, currency: "USD" }, note: "x\u0000" },
    });
    expectError(adjusted, "validation_failed", 400);
    expect(adjusted.body.error?.message).toBe("Text contains characters that can't be stored");
    expect((await getAccountRow(account))?.balance).toBe(0);
  });

  it("takes path params over body keys and rejects unknown body keys", async () => {
    const { app } = testApp();
    const user = await seedUser();
    const token = await tokenFor(user);
    const mine = await seedAccount(user);
    const theirs = await seedAccount(await seedUser(), { balance: 500 });
    const response = await raw(app, "POST", `/accounts/${mine}/adjustments`, {
      token,
      idempotencyKey: KEY,
      body: { amount: { amountMinor: 1, currency: "USD" }, id: theirs },
    });
    expect(response.status).toBe(200);
    expect((await getAccountRow(mine))?.balance).toBe(1);
    expect((await getAccountRow(theirs))?.balance).toBe(500);

    const extra = await raw(app, "POST", `/accounts/${mine}/adjustments`, {
      token,
      idempotencyKey: "router-test-key-0002",
      body: { amount: { amountMinor: 1, currency: "USD" }, extra: true },
    });
    expectError(extra, "validation_failed", 400);
  });

  it("refuses a token whose subject or channel identity can't be an id", async () => {
    const { app } = testApp();
    for (const token of [
      await testTokens.mint("not-a-uuid", ALL_SCOPES, 600),
      await testTokens.mint((await seedUser()).toUpperCase(), ALL_SCOPES, 600),
      await testTokens.mint(await seedUser(), ALL_SCOPES, 600, { channelIdentityId: "ci-1" }),
    ]) {
      const response = await raw(app, "GET", "/accounts", { token });
      expectError(response, "unauthorized", 401);
      expect(response.body.error?.message).toBe("Invalid token");
    }
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
      const error = await expectApiError(
        client.accounts.adjust({ id: account, amount: { amountMinor: 1, currency: "USD" } }),
        "forbidden",
        403,
      );
      expect(error.message).toBe("Channel link lacks the finance:write scope");
      expect((await getAccountRow(account))?.balance).toBe(100);
    });
  });

  describe("web-only routes", () => {
    it("refuse chat tokens, but not plain user tokens", async () => {
      const { app } = testApp();
      const user = await seedUser();
      const account = await seedAccount(user);
      const identity = await seedChannelIdentity(user);
      const chat = clientFor(app, await tokenFor(user, ALL_SCOPES, { channelIdentityId: identity }));
      const calls = [
        () => chat.profile.get(),
        () => chat.profile.create({ baseCurrency: "EUR" }),
        () => chat.profile.completeOnboarding(),
        () => chat.accounts.create({ name: "x", type: "bank", balance: { amountMinor: 0, currency: "USD" } }),
        () => chat.accounts.update({ id: account, name: "x" }),
        () => chat.accounts.archive({ id: account }),
        () => chat.accounts.restore({ id: account }),
        () => chat.accounts.delete({ id: account }),
      ];
      for (const call of calls) {
        const error = await expectApiError(call(), "forbidden", 403);
        expect(error.message).toBe("Not available to chat tokens");
      }
      expect(await getAccountRow(account)).toMatchObject({ name: "Checking", archived: false });
      expect((await clientFor(app, await tokenFor(user)).profile.get()).profile).toMatchObject({ baseCurrency: "USD" });
    });
  });

  it("refuses agent-store routes to tokens without a chat identity", async () => {
    const agentHistory = { delete: operation(routes.agentHistory.delete, async () => ({ deleted: true as const })) };
    const { app } = testApp({ operations: { ...operations, agentHistory } });
    const user = await seedUser();
    const plain = await raw(app, "DELETE", "/agent/history", { token: await tokenFor(user) });
    expectError(plain, "forbidden", 403);
    expect(plain.body.error?.message).toBe("Agent routes need a token for a linked chat");
    const identity = await seedChannelIdentity(user, { readOnly: true });
    const chat = await raw(app, "DELETE", "/agent/history", { token: await tokenFor(user, ["agent:state"], { channelIdentityId: identity }) });
    expect(chat.status).toBe(200);
  });

  describe("commitThenFail", () => {
    const missingId = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

    it("commits the handler's writes, then answers the error", async () => {
      // A fake agent-store write: stores a row, then reports a conflict (like confirming an expired action).
      const agentPendingActions = {
        ...operations.agentPendingActions,
        cancel: operation(routes.agentPendingActions.cancel, async (tx) => {
          await tx.insert(agentInboundEvents).values({
            channel: "telegram",
            eventId: "kept",
            status: "received",
            payload: "{}",
            receivedAt: new Date(),
            updatedAt: new Date(),
          });
          return commitThenFail(conflict("Pending action expired", { status: "expired" }));
        }),
      };
      const { app } = testApp({ operations: { ...operations, agentPendingActions } });
      const user = await seedUser();
      const token = await tokenFor(user, ["agent:state"], { channelIdentityId: await seedChannelIdentity(user) });
      const response = await raw(app, "POST", `/agent/pending-actions/${missingId}/cancel`, { token, body: {} });
      expectError(response, "conflict", 409);
      expect(response.body.error).toEqual({ code: "conflict", message: "Pending action expired", details: { status: "expired" } });
      expect(await testDb().select().from(agentInboundEvents)).toHaveLength(1);
    });

    it("is a 500 on a route with an Idempotency-Key, and rolls back", async () => {
      const failing = {
        ...operations.accounts,
        adjust: operation(routes.accounts.adjust, async (tx, user) => {
          await tx.update(accounts).set({ balance: 1 }).where(eq(accounts.userId, user.userId));
          return commitThenFail(conflict("nope"));
        }),
      };
      const { app } = testApp({ operations: { ...operations, accounts: failing } });
      const user = await seedUser();
      const account = await seedAccount(user);
      const response = await raw(app, "POST", `/accounts/${account}/adjustments`, {
        token: await tokenFor(user),
        idempotencyKey: KEY,
        body: { amount: { amountMinor: 1, currency: "USD" } },
      });
      expectError(response, "internal", 500);
      expect((await getAccountRow(account))?.balance).toBe(0);
    });
  });

  it("runs service handlers in a transaction: a failed write rolls back", async () => {
    const agentEvents = {
      ...serviceOperations.agentEvents,
      claim: serviceOperation(routes.agentEvents.claim, async (tx, _ctx, input) => {
        await tx
          .insert(agentInboundEvents)
          .values({ channel: input.channel, eventId: input.eventId, status: "received", payload: "{}", receivedAt: new Date(), updatedAt: new Date() });
        throw conflict("after the write");
      }),
    };
    const { app } = testApp({ serviceOperations: { ...serviceOperations, agentEvents } });
    const response = await raw(app, "POST", "/agent/events/claim", { token: TEST_SERVICE_KEY, body: { channel: "telegram", eventId: "1", payload: "{}" } });
    expectError(response, "conflict", 409);
    expect(await testDb().select().from(agentInboundEvents)).toHaveLength(0);
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
      const created = await raw(app, "POST", "/profile", { cookie, idempotencyKey: KEY, body: { baseCurrency: "AOA" } });
      expect(created.status).toBe(200);
      const account = await raw(app, "POST", "/accounts", {
        cookie,
        idempotencyKey: "router-test-key-0003",
        body: { name: "Banco", type: "bank", balance: { amountMinor: 5_000, currency: "AOA" } },
      });
      expect(account.status).toBe(200);
      const listed = await raw(app, "GET", "/accounts", { cookie });
      expect((listed.body.data as { items: unknown[] }).items).toHaveLength(1);
      expectError(await raw(app, "POST", "/profile/complete-onboarding", { cookie }), "validation_failed", 400);
    });

    it("are not tried when an Authorization header is present", async () => {
      const { app, cookie } = await signedIn();
      expectError(await raw(app, "GET", "/accounts", { cookie, token: "not.a.jwt" }), "unauthorized", 401);
    });
  });
});
