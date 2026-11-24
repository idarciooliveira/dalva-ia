import { describe, expect, it } from "vitest";

import {
  getAccountRow,
  linkedChat,
  seedAccount,
  seedChannelIdentity,
  seedUser,
  tokenFor,
  transactionRows,
} from "../../test/api";
import { TEST_PUBLIC_URL, TEST_SERVICE_KEY, testApp, testTokens } from "../../test/app";
import { testDb } from "../../test/db";
import { expectTrpcError, rawMutation, trpcFor } from "../../test/trpc";
import { savingsGoals } from "../db/schema";

type App = ReturnType<typeof testApp>["app"];

async function oneUser() {
  const { app } = testApp();
  const user = await seedUser();
  return { app, user, client: trpcFor(app, { token: await tokenFor(user) }) };
}

/** Two onboarded users with a USD account each (1000.00 and 500.00). */
async function twoUsers(app: App = testApp().app) {
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
    asAlice: trpcFor(app, { token: await tokenFor(alice) }),
    asBob: trpcFor(app, { token: await tokenFor(bob) }),
  };
}

describe("trpc accounts", () => {
  it("lists and gets accounts with Money in the account currency", async () => {
    const { app, asAlice, aliceAccount, alice } = await twoUsers();
    const archived = await seedAccount(alice, { name: "Old", currency: "EUR", balance: 5, archived: true });

    const { items } = await asAlice.accounts.list.query();
    expect(items).toEqual([
      { id: aliceAccount, name: "Checking", type: "bank", balance: { amountMinor: 100_000, currency: "USD" } },
    ]);
    const all = await asAlice.accounts.list.query({ includeArchived: true });
    expect(all.items.map((a) => a.id)).toEqual([aliceAccount, archived]);
    expect(all.items[1]).toMatchObject({ archived: true, balance: { amountMinor: 5, currency: "EUR" } });

    const { account } = await asAlice.accounts.get.query({ id: aliceAccount });
    expect(account.balance).toEqual({ amountMinor: 100_000, currency: "USD" });

    const response = await app.request("/api/trpc/accounts.list", { headers: { authorization: `Bearer ${await tokenFor(alice)}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("converts balances for 0- and 3-decimal currencies", async () => {
    const { user, client } = await oneUser();
    const jpy = await seedAccount(user, { currency: "JPY", balance: 123_456 });
    const kwd = await seedAccount(user, { currency: "KWD", balance: 1234 });
    expect((await client.accounts.get.query({ id: jpy })).account.balance).toEqual({ amountMinor: 1235, currency: "JPY" });
    expect((await client.accounts.get.query({ id: kwd })).account.balance).toEqual({ amountMinor: 12_340, currency: "KWD" });
  });

  it("batches reads into one request", async () => {
    const { app } = testApp();
    const user = await seedUser();
    const a = await seedAccount(user, { name: "A" });
    const client = trpcFor(app, { token: await tokenFor(user), batch: true });
    const [list, one] = await Promise.all([client.accounts.list.query(), client.accounts.get.query({ id: a })]);
    expect(list.items).toHaveLength(1);
    expect(one.account.name).toBe("A");
  });

  describe("adjust", () => {
    it("adjusts a balance, records an adjustment dated today and returns the account", async () => {
      const { asAlice, aliceAccount } = await twoUsers();
      const { account } = await asAlice.accounts.adjust.mutate({
        id: aliceAccount,
        amount: { amountMinor: -2_500, currency: "USD" },
        note: "Reconcile",
      });
      expect(account.balance).toEqual({ amountMinor: 97_500, currency: "USD" });
      expect(await transactionRows()).toEqual([
        expect.objectContaining({
          accountId: aliceAccount,
          type: "adjustment",
          amount: -2_500,
          description: "Balance adjustment",
          note: "Reconcile",
          date: new Date().toISOString().slice(0, 10),
        }),
      ]);
    });

    it("uses the given date and converts 3-decimal input, refusing what x100 storage can't hold", async () => {
      const { user, client } = await oneUser();
      const kwd = await seedAccount(user, { currency: "KWD", balance: 0 });
      const precision = await expectTrpcError(
        client.accounts.adjust.mutate({ id: kwd, amount: { amountMinor: 1_235, currency: "KWD" } }),
        "validation_failed",
        400,
      );
      expect(precision.data?.details).toMatchObject({ reason: "precision" });
      const { account } = await client.accounts.adjust.mutate({ id: kwd, amount: { amountMinor: 1_240, currency: "KWD" }, date: "2026-01-02" });
      expect((await getAccountRow(kwd))?.balance).toBe(124);
      expect(account.balance).toEqual({ amountMinor: 1_240, currency: "KWD" });
      expect((await transactionRows())[0]?.date).toBe("2026-01-02");
    });

    it("refuses a balance the API can't express, and rolls back", async () => {
      const { user, client } = await oneUser();
      const kwd = await seedAccount(user, { currency: "KWD", balance: 900_000_000_000_000 });
      const error = await expectTrpcError(
        client.accounts.adjust.mutate({ id: kwd, amount: { amountMinor: 1_000_000_000_000_000, currency: "KWD" } }),
        "validation_failed",
        400,
      );
      expect(error.message).toBe("Balance out of range");
      expect((await getAccountRow(kwd))?.balance).toBe(900_000_000_000_000);
      expect(await transactionRows()).toEqual([]);
    });

    it("rejects a currency mismatch, a zero amount, a bad date and a malformed id", async () => {
      const { asAlice, aliceAccount } = await twoUsers();
      const error = await expectTrpcError(
        asAlice.accounts.adjust.mutate({ id: aliceAccount, amount: { amountMinor: 100, currency: "EUR" } }),
        "validation_failed",
        400,
      );
      expect(error.data?.details).toEqual({ issues: [{ path: "amount.currency", message: "Currency must be USD, got EUR" }] });
      const zero = await expectTrpcError(
        asAlice.accounts.adjust.mutate({ id: aliceAccount, amount: { amountMinor: 0, currency: "USD" } }),
        "validation_failed",
      );
      expect(zero.message).toBe("Request validation failed");
      expect(zero.data?.details).toEqual({ issues: [{ path: "amount.amountMinor", message: "Amount must not be zero" }] });
      await expectTrpcError(
        asAlice.accounts.adjust.mutate({ id: aliceAccount, amount: { amountMinor: 1, currency: "USD" }, date: "2026-02-30" }),
        "validation_failed",
      );
      const badId = await expectTrpcError(asAlice.accounts.get.query({ id: "not-an-id" }), "validation_failed", 400);
      expect(badId.data?.details).toEqual({ issues: [{ path: "id", message: "Invalid id" }] });
      expect((await getAccountRow(aliceAccount))?.balance).toBe(100_000);
      expect(await transactionRows()).toEqual([]);
    });
  });

  describe("create, update, archive, restore, delete", () => {
    it("creates an account in the currency of its opening balance", async () => {
      const { user, client } = await oneUser();
      const { account } = await client.accounts.create.mutate({
        name: "Wallet",
        type: "cash",
        balance: { amountMinor: 1_240, currency: "KWD" },
        theme: "azul",
      });
      expect(account).toEqual({ id: account.id, name: "Wallet", type: "cash", balance: { amountMinor: 1_240, currency: "KWD" }, theme: "azul" });
      expect(await getAccountRow(account.id)).toMatchObject({ userId: user, balance: 124, currency: "KWD", archived: false });

      const negative = await client.accounts.create.mutate({ name: "Card", type: "credit_card", balance: { amountMinor: -5_000, currency: "USD" } });
      expect(negative.account.balance).toEqual({ amountMinor: -5_000, currency: "USD" });
      await expectTrpcError(
        client.accounts.create.mutate({ name: "Bad", type: "bank", balance: { amountMinor: 1_235, currency: "KWD" } }),
        "validation_failed",
      );
      expect((await client.accounts.list.query()).items.map((a) => a.name)).toEqual(["Wallet", "Card"]);
    });

    it("supports every account type", async () => {
      const { client } = await oneUser();
      const types = ["bank", "savings", "credit_card", "cash", "e_wallet", "loan", "investment"] as const;
      for (const type of types) {
        await client.accounts.create.mutate({ name: `${type} account`, type, balance: { amountMinor: 0, currency: "USD" } });
      }
      expect((await client.accounts.list.query()).items.map((a) => a.type)).toEqual(types);
    });

    it("updates only the given fields", async () => {
      const { asAlice, aliceAccount } = await twoUsers();
      const { account } = await asAlice.accounts.update.mutate({ id: aliceAccount, name: "New Name", type: "savings", theme: "verde", icon: "piggy-bank" });
      expect(account).toEqual({
        id: aliceAccount,
        name: "New Name",
        type: "savings",
        theme: "verde",
        icon: "piggy-bank",
        balance: { amountMinor: 100_000, currency: "USD" },
      });
      const described = await asAlice.accounts.update.mutate({ id: aliceAccount, description: "Main" });
      expect(described.account).toMatchObject({ name: "New Name", theme: "verde", description: "Main" });
    });

    it("refuses an update with no field, or with the currency or balance", async () => {
      const { asAlice, aliceAccount } = await twoUsers();
      for (const fields of [{}, { currency: "EUR" }, { balance: { amountMinor: 1, currency: "USD" } }]) {
        await expectTrpcError(asAlice.accounts.update.mutate({ id: aliceAccount, ...fields } as never), "validation_failed", 400);
      }
      expect(await getAccountRow(aliceAccount)).toMatchObject({ currency: "USD", balance: 100_000 });
    });

    it("archives and restores", async () => {
      const { asAlice, aliceAccount } = await twoUsers();
      expect((await asAlice.accounts.archive.mutate({ id: aliceAccount })).account.archived).toBe(true);
      expect((await asAlice.accounts.list.query()).items).toEqual([]);
      expect((await asAlice.accounts.get.query({ id: aliceAccount })).account.archived).toBe(true);
      expect((await asAlice.accounts.restore.mutate({ id: aliceAccount })).account.archived).not.toBe(true);
      expect((await asAlice.accounts.list.query()).items.map((a) => a.id)).toEqual([aliceAccount]);
    });

    it("deletes an unused account, and refuses one in use with conflict", async () => {
      const { asAlice, alice, aliceAccount } = await twoUsers();
      const spare = await seedAccount(alice, { name: "Spare" });
      expect(await asAlice.accounts.delete.mutate({ id: spare })).toEqual({ id: spare });
      await expectTrpcError(asAlice.accounts.get.query({ id: spare }), "not_found", 404);

      await asAlice.accounts.adjust.mutate({ id: aliceAccount, amount: { amountMinor: 1, currency: "USD" } });
      const inUse = await expectTrpcError(asAlice.accounts.delete.mutate({ id: aliceAccount }), "conflict", 409);
      expect(inUse.message).toMatch(/archive it instead/i);

      const goalAccount = await seedAccount(alice, { name: "Goal" });
      await testDb().insert(savingsGoals).values({ userId: alice, name: "g", targetAmount: 1, isVirtual: false, linkedAccountId: goalAccount });
      await expectTrpcError(asAlice.accounts.delete.mutate({ id: goalAccount }), "conflict", 409);
      expect(await getAccountRow(aliceAccount)).toBeDefined();
    });
  });

  it("isolates users: B can't read or change A's account", async () => {
    const { asBob, aliceAccount } = await twoUsers();
    await expectTrpcError(asBob.accounts.get.query({ id: aliceAccount }), "not_found", 404);
    await expectTrpcError(asBob.accounts.adjust.mutate({ id: aliceAccount, amount: { amountMinor: 1, currency: "USD" } }), "not_found", 404);
    await expectTrpcError(asBob.accounts.update.mutate({ id: aliceAccount, name: "Hacked" }), "not_found", 404);
    await expectTrpcError(asBob.accounts.archive.mutate({ id: aliceAccount }), "not_found", 404);
    await expectTrpcError(asBob.accounts.restore.mutate({ id: aliceAccount }), "not_found", 404);
    await expectTrpcError(asBob.accounts.delete.mutate({ id: aliceAccount }), "not_found", 404);
    expect((await asBob.accounts.list.query({ includeArchived: true })).items.map((a) => a.id)).not.toContain(aliceAccount);
    expect(await getAccountRow(aliceAccount)).toMatchObject({ name: "Checking", balance: 100_000, archived: false });
    expect(await transactionRows()).toEqual([]);
  });

  describe("Idempotency-Key", () => {
    const KEY = "trpc-test-key-0001";

    it("replays the stored response for the same key and input, without writing twice", async () => {
      const { app, alice, aliceAccount } = await twoUsers();
      const token = await tokenFor(alice);
      const body = { id: aliceAccount, amount: { amountMinor: -100, currency: "USD" } };
      const first = await rawMutation(app, "accounts.adjust", body, { authorization: `Bearer ${token}`, "idempotency-key": KEY });
      // Same input, keys in another order.
      const again = await rawMutation(app, "accounts.adjust", { amount: { currency: "USD", amountMinor: -100 }, id: aliceAccount }, {
        authorization: `Bearer ${token}`,
        "idempotency-key": KEY,
      });
      expect(first.status).toBe(200);
      expect(again.status).toBe(200);
      expect(again.headers.get("Idempotent-Replayed")).toBe("true");
      expect(first.headers.get("Idempotent-Replayed")).toBeNull();
      expect(again.body).toEqual(first.body);
      expect(await transactionRows()).toHaveLength(1);
      expect((await getAccountRow(aliceAccount))?.balance).toBe(99_900);
    });

    it("refuses the same key with another input or procedure", async () => {
      const { asAlice, aliceAccount } = await twoUsers();
      await asAlice.accounts.adjust.mutate({ id: aliceAccount, amount: { amountMinor: 1, currency: "USD" } }, { context: { idempotencyKey: KEY } });
      await expectTrpcError(
        asAlice.accounts.adjust.mutate({ id: aliceAccount, amount: { amountMinor: 2, currency: "USD" } }, { context: { idempotencyKey: KEY } }),
        "conflict",
        409,
      );
      await expectTrpcError(asAlice.accounts.archive.mutate({ id: aliceAccount }, { context: { idempotencyKey: KEY } }), "conflict", 409);
      expect(await transactionRows()).toHaveLength(1);
    });

    it("stores nothing for a failed write, so the key can be retried", async () => {
      const { asAlice, aliceAccount } = await twoUsers();
      await expectTrpcError(
        asAlice.accounts.adjust.mutate({ id: aliceAccount, amount: { amountMinor: 1, currency: "EUR" } }, { context: { idempotencyKey: KEY } }),
        "validation_failed",
      );
      await asAlice.accounts.adjust.mutate({ id: aliceAccount, amount: { amountMinor: 1, currency: "USD" } }, { context: { idempotencyKey: KEY } });
      expect((await getAccountRow(aliceAccount))?.balance).toBe(100_001);
    });

    it("is required on writes, and writes can't share one in a batch", async () => {
      const { app, alice, aliceAccount } = await twoUsers();
      const token = await tokenFor(alice);
      const missing = await expectTrpcError(
        trpcFor(app, { token, idempotencyKey: null }).accounts.archive.mutate({ id: aliceAccount }),
        "validation_failed",
        400,
      );
      expect(missing.data?.details).toEqual({ issues: [{ path: "Idempotency-Key", message: "Required" }] });
      await expectTrpcError(
        trpcFor(app, { token, idempotencyKey: "short" }).accounts.archive.mutate({ id: aliceAccount }),
        "validation_failed",
        400,
      );

      const batch = await app.request("/api/trpc/accounts.archive,accounts.restore?batch=1", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": KEY, "content-type": "application/json" },
        body: JSON.stringify({ 0: { id: aliceAccount }, 1: { id: aliceAccount } }),
      });
      const results = (await batch.json()) as Array<{ error?: { data: { apiCode: string } } }>;
      expect(results.map((r) => r.error?.data.apiCode)).toEqual(["validation_failed", "validation_failed"]);
      expect(await getAccountRow(aliceAccount)).toMatchObject({ archived: false });
    });
  });

  describe("credentials and scopes", () => {
    it("refuses anonymous callers, bad tokens and the service key with unauthorized", async () => {
      const { app } = testApp();
      const user = await seedUser();
      const account = await seedAccount(user);
      const anonymous = await expectTrpcError(trpcFor(app).accounts.list.query(), "unauthorized", 401);
      expect(anonymous.message).toBe("Authentication required");
      const response = await app.request("/api/trpc/accounts.list");
      expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="finance-api"');

      const bad = await expectTrpcError(trpcFor(app, { token: "not.a.jwt" }).accounts.get.query({ id: account }), "unauthorized", 401);
      expect(bad.message).toBe("Invalid token");
      const expired = await expectTrpcError(
        trpcFor(app, { token: await testTokens.mint(user, ["finance:read"], 60, { now: Math.floor(Date.now() / 1000) - 3600 }) }).accounts.list.query(),
        "unauthorized",
        401,
      );
      expect(expired.message).toBe("Token expired");
      await expectTrpcError(trpcFor(app, { token: TEST_SERVICE_KEY }).accounts.list.query(), "unauthorized", 401);
    });

    it("checks the token's scopes", async () => {
      const { app, alice, aliceAccount } = await twoUsers();
      const readOnly = trpcFor(app, { token: await tokenFor(alice, ["finance:read"]) });
      expect((await readOnly.accounts.list.query()).items).toHaveLength(1);
      const error = await expectTrpcError(
        readOnly.accounts.adjust.mutate({ id: aliceAccount, amount: { amountMinor: 1, currency: "USD" } }),
        "forbidden",
        403,
      );
      expect(error.message).toBe("Missing scope: finance:write");
      await expectTrpcError(trpcFor(app, { token: await tokenFor(alice, ["agent:state"]) }).accounts.list.query(), "forbidden", 403);
    });

    it("lets a chat token read and adjust, but not manage accounts (web only)", async () => {
      const { app } = testApp();
      const chat = await linkedChat(app, { withAccount: true });
      const agent = trpcFor(app, { token: chat.token });
      expect((await agent.accounts.list.query()).items.map((a) => a.id)).toEqual([chat.accountId]);
      await agent.accounts.adjust.mutate({ id: chat.accountId!, amount: { amountMinor: 100, currency: "USD" } });
      const forbidden = await expectTrpcError(
        agent.accounts.create.mutate({ name: "X", type: "cash", balance: { amountMinor: 0, currency: "USD" } }),
        "forbidden",
        403,
      );
      expect(forbidden.message).toBe("Not available to chat tokens");
      await expectTrpcError(agent.accounts.archive.mutate({ id: chat.accountId! }), "forbidden", 403);
      expect((await getAccountRow(chat.accountId!))?.balance).toBe(100_100);
    });

    it("re-checks the chat link in each request: read-only blocks writes, unlinked is unauthorized", async () => {
      const { app } = testApp();
      const user = await seedUser();
      const account = await seedAccount(user);
      const readOnlyIdentity = await seedChannelIdentity(user, { readOnly: true });
      const readOnly = trpcFor(app, { token: await tokenFor(user, undefined, { channelIdentityId: readOnlyIdentity }) });
      expect((await readOnly.accounts.list.query()).items).toHaveLength(1);
      const error = await expectTrpcError(
        readOnly.accounts.adjust.mutate({ id: account, amount: { amountMinor: 1, currency: "USD" } }),
        "forbidden",
        403,
      );
      expect(error.message).toBe("Channel link lacks the finance:write scope");

      const unlinked = await seedChannelIdentity(user, { unlinked: true });
      const revoked = await expectTrpcError(
        trpcFor(app, { token: await tokenFor(user, undefined, { channelIdentityId: unlinked }) }).accounts.list.query(),
        "unauthorized",
        401,
      );
      expect(revoked.message).toBe("Channel link revoked");
      expect(await transactionRows()).toEqual([]);
    });

    it("accepts the web session cookie, but not on writes from another origin", async () => {
      const { app } = testApp();
      const res = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_PUBLIC_URL },
        body: JSON.stringify({ name: "Ana", email: "ana@example.com", password: "correct horse battery" }),
      });
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith("dalva.session_token="))!.split(";")[0]!;
      const web = trpcFor(app, { cookie });
      const { account } = await web.accounts.create.mutate({ name: "Banco", type: "bank", balance: { amountMinor: 5_000, currency: "AOA" } });
      expect((await web.accounts.list.query()).items.map((a) => a.id)).toEqual([account.id]);

      const crossSite = await rawMutation(app, "accounts.archive", { id: account.id }, { cookie, origin: "https://evil.example", "idempotency-key": "trpc-test-key-0002" });
      expect(crossSite.status).toBe(401);
      expect(crossSite.body.error?.data.apiCode).toBe("unauthorized");
    });
  });

  it("answers unknown procedures, bad JSON and oversized bodies with the v1 codes", async () => {
    const { app, alice } = await twoUsers();
    const auth = { authorization: `Bearer ${await tokenFor(alice)}`, "idempotency-key": "trpc-test-key-0003" };
    const unknown = await rawMutation(app, "accounts.nope", {}, auth);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error?.data.apiCode).toBe("not_found");
    const badJson = await rawMutation(app, "accounts.create", "{", auth);
    expect(badJson.status).toBe(400);
    expect(badJson.body.error?.data.apiCode).toBe("validation_failed");
    const big = await rawMutation(app, "accounts.create", { name: "x".repeat(70 * 1024) }, auth);
    expect(big.status).toBe(413);
    expect(big.body.error?.data.apiCode).toBe("validation_failed");
  });
});
