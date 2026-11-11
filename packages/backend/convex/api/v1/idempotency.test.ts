import { routes } from "@mpf/finance-contract";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";

import { internal } from "../../_generated/api";
import { IDEMPOTENCY_TTL_MS } from "./idempotency";
import { REPLAYED_HEADER } from "./router";
import { expectConforms, getDoc, raw, setupApi, tokenFor, twoUsers } from "./test.helpers";

const body = (amountMinor = 1_000) => ({
  type: "expense",
  amount: { amountMinor, currency: "USD" },
  date: "2026-03-01",
});

describe("api/v1 idempotency", () => {
  it("replays the stored response for the same key and body without re-executing", async () => {
    const t = setupApi();
    const { alice, aliceAccount } = await twoUsers(t);
    const token = await tokenFor(alice);
    const request = { token, idempotencyKey: "same-key-0001", body: { ...body(), accountId: aliceAccount } };

    const first = await raw(t, "POST", "/transactions", request);
    const firstData = expectConforms(routes.transactions.create, first);
    expect(first.headers.get(REPLAYED_HEADER)).toBeNull();

    // Same body with keys in another order.
    const { accountId, ...rest } = request.body;
    const second = await raw(t, "POST", "/transactions", { ...request, body: { accountId, ...rest } });
    expect(expectConforms(routes.transactions.create, second)).toEqual(firstData);
    expect(second.headers.get(REPLAYED_HEADER)).toBe("true");

    expect((await getDoc(t, aliceAccount))?.balance).toBe(99_000);
    const rows = await t.run((ctx) => ctx.db.query("transactions").take(10));
    expect(rows).toHaveLength(1);
  });

  it("returns conflict for the same key with a different body or operation", async () => {
    const t = setupApi();
    const { alice, aliceAccount } = await twoUsers(t);
    const token = await tokenFor(alice);
    const idempotencyKey = "conflict-key-0001";
    await raw(t, "POST", "/transactions", { token, idempotencyKey, body: { ...body(), accountId: aliceAccount } });

    const changed = await raw(t, "POST", "/transactions", { token, idempotencyKey, body: { ...body(2_000), accountId: aliceAccount } });
    expect(changed.status).toBe(409);
    expect(changed.body.error?.code).toBe("conflict");

    const otherOp = await raw(t, "POST", `/accounts/${aliceAccount}/adjustments`, {
      token,
      idempotencyKey,
      body: { amount: { amountMinor: 5, currency: "USD" } },
    });
    expect(otherOp.status).toBe(409);
    expect((await getDoc(t, aliceAccount))?.balance).toBe(99_000);
  });

  it("scopes keys per user", async () => {
    const t = setupApi();
    const { alice, bob, aliceAccount, bobAccount } = await twoUsers(t);
    const idempotencyKey = "shared-key-0001";
    const a = await raw(t, "POST", "/transactions", { token: await tokenFor(alice), idempotencyKey, body: { ...body(), accountId: aliceAccount } });
    const b = await raw(t, "POST", "/transactions", { token: await tokenFor(bob), idempotencyKey, body: { ...body(), accountId: bobAccount } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.headers.get(REPLAYED_HEADER)).toBeNull();
    expect((await getDoc(t, bobAccount))?.balance).toBe(49_000);
  });

  it("stores nothing when the write fails, so the key can be retried", async () => {
    const t = setupApi();
    const { alice, aliceAccount } = await twoUsers(t);
    const token = await tokenFor(alice);
    const idempotencyKey = "retry-key-0001";
    const failed = await raw(t, "POST", "/transactions", {
      token,
      idempotencyKey,
      body: { ...body(), accountId: aliceAccount, categoryId: "missing" },
    });
    expect(failed.status).toBe(400);
    expect(await t.run((ctx) => ctx.db.query("apiIdempotencyKeys").take(10))).toHaveLength(0);

    const ok = await raw(t, "POST", "/transactions", { token, idempotencyKey, body: { ...body(), accountId: aliceAccount } });
    expect(ok.status).toBe(200);
  });

  it("rolls back the write and stores no key when the handler fails after writing", async () => {
    const t = setupApi();
    const { alice, aliceAccount } = await twoUsers(t);
    const writeThenFail = makeFunctionReference<"mutation">("api/v1/test.fixtures:writeThenFail");
    await expect(
      t.mutation(writeThenFail, {
        userId: alice,
        input: { id: aliceAccount, amount: { amountMinor: 1, currency: "USD" } },
        idempotencyKey: "rollback-key-0001",
        requestHash: "h",
      }),
    ).rejects.toThrow(/boom/);
    expect((await getDoc(t, aliceAccount))?.balance).toBe(100_000);
    expect(await t.run((ctx) => ctx.db.query("apiIdempotencyKeys").take(10))).toHaveLength(0);
  });

  it("stores the response with the key in the same mutation as the write", async () => {
    const t = setupApi();
    const { asAlice, alice, aliceAccount } = await twoUsers(t);
    const { account } = await asAlice.accounts.adjust(
      { id: aliceAccount, amount: { amountMinor: 1, currency: "USD" } },
      { idempotencyKey: "stored-key-0001" },
    );
    const [record] = await t.run((ctx) => ctx.db.query("apiIdempotencyKeys").take(10));
    expect(record).toMatchObject({ userId: alice, key: "stored-key-0001", response: { account } });
    expect(record?.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("purges keys older than the TTL", async () => {
    const t = setupApi();
    const now = Date.now();
    await t.run(async (ctx) => {
      for (const [key, age] of [["old-key-0001", IDEMPOTENCY_TTL_MS + 1], ["new-key-0001", 1000]] as const) {
        await ctx.db.insert("apiIdempotencyKeys", { userId: "u", key, requestHash: "h", response: {}, createdAt: now - age });
      }
    });
    expect(await t.mutation(internal.api.v1.idempotency.purgeExpired, { now })).toBe(1);
    const left = await t.run((ctx) => ctx.db.query("apiIdempotencyKeys").take(10));
    expect(left.map((r) => r.key)).toEqual(["new-key-0001"]);
  });
});
