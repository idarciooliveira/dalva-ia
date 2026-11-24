import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { expectOk, getAccountRow, raw, seedAccount, seedUser, tokenFor, transactionRows, twoUsers } from "../../test/api";
import { createTestUser, testApp } from "../../test/app";
import { testDb } from "../../test/db";
import { accounts, apiIdempotencyKeys, transactions } from "../db/schema";
import { adjustBalance } from "../domain/accounts";
import { DomainError } from "../domain/errors";
import { appAmount } from "../domain/money";
import { createLogger } from "../log";
import { accountAdjustInput } from "./accounts";
import { accountDto, todayUtc } from "./dto";
import { financeWrite, REPLAYED_HEADER, router } from "./init";
import { IDEMPOTENCY_TTL_MS, purgeExpiredIdempotencyKeys } from "../http/idempotency";

const adjustment = (amountMinor = 1_000) => ({ amount: { amountMinor, currency: "USD" }, date: "2026-03-01" });
const keyRows = () => testDb().select().from(apiIdempotencyKeys);

/** The app with `accounts.adjust` replaced by `handler` (the real adjustment is `realAdjust`). */
function adjustedBy(handler: Parameters<ReturnType<typeof financeWrite.input<typeof accountAdjustInput>>["mutation"]>[0]) {
  return testApp({ router: router({ accounts: router({ adjust: financeWrite.input(accountAdjustInput).mutation(handler) }) }) }).app;
}

const realAdjust: Parameters<typeof adjustedBy>[0] = async ({ ctx, input }) => {
  const account = await adjustBalance(ctx.tx, ctx.user.userId, {
    id: input.id,
    amount: appAmount(input.amount, "USD", "amount"),
    date: input.date ?? todayUtc(),
    note: input.note,
  });
  return { account: accountDto(account) };
};

type Request = { token: string; idempotencyKey?: string; body: Record<string, unknown> };
type App = ReturnType<typeof testApp>["app"];
/** `accounts.adjust` on `account`, the request as `{ token, idempotencyKey, body }`. */
const adjust = (app: App, account: string, { body, ...options }: Request) => raw(app, "accounts.adjust", { id: account, ...body }, options);
const create = (app: App, { body, ...options }: Request) => raw(app, "accounts.create", body, options);

describe("idempotency", () => {
  it("replays the stored response for the same key and body without re-executing", async () => {
    const { app, alice, aliceAccount } = await twoUsers();
    const token = await tokenFor(alice);
        const request = { token, idempotencyKey: "same-key-0001", body: { ...adjustment(-1_000), note: "n" } };

    const first = await adjust(app, aliceAccount, request);
    const firstData = expectOk(first);
    expect(first.headers.get(REPLAYED_HEADER)).toBeNull();

    // Same body with keys in another order.
    const { note, ...rest } = request.body;
    const second = await adjust(app, aliceAccount, { ...request, body: { note, ...rest } });
    expect(expectOk(second)).toEqual(firstData);
    expect(second.headers.get(REPLAYED_HEADER)).toBe("true");

    expect((await getAccountRow(aliceAccount))?.balance).toBe(99_000);
    expect(await transactionRows()).toHaveLength(1);
  });

  it("returns conflict for the same key with a different body or operation", async () => {
    const { app, alice, aliceAccount } = await twoUsers();
    const token = await tokenFor(alice);
    const idempotencyKey = "conflict-key-0001";
        await adjust(app, aliceAccount, { token, idempotencyKey, body: adjustment(-1_000) });

    const changed = await adjust(app, aliceAccount, { token, idempotencyKey, body: adjustment(-2_000) });
    expect(changed.status).toBe(409);
    expect(changed.body.error?.code).toBe("conflict");

    const otherOp = await create(app, {
      token,
      idempotencyKey,
      body: { name: "New", type: "bank", balance: { amountMinor: 0, currency: "USD" } },
    });
    expect(otherOp.status).toBe(409);
    expect((await getAccountRow(aliceAccount))?.balance).toBe(99_000);
    expect(await testDb().select().from(accounts).where(eq(accounts.userId, alice))).toHaveLength(1);
  });

  it("scopes keys per user", async () => {
    const { app, alice, bob, aliceAccount, bobAccount } = await twoUsers();
    const idempotencyKey = "shared-key-0001";
    const a = await adjust(app, aliceAccount, { token: await tokenFor(alice), idempotencyKey, body: adjustment(-1_000) });
    const b = await adjust(app, bobAccount, { token: await tokenFor(bob), idempotencyKey, body: adjustment(-1_000) });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.headers.get(REPLAYED_HEADER)).toBeNull();
    expect((await getAccountRow(bobAccount))?.balance).toBe(49_000);
  });

  it("stores nothing when the write fails, so the key can be retried", async () => {
    const { app, alice, aliceAccount } = await twoUsers();
    const token = await tokenFor(alice);
    const idempotencyKey = "retry-key-0001";
        const failed = await adjust(app, aliceAccount, { token, idempotencyKey, body: { amount: { amountMinor: 1, currency: "EUR" } } });
    expect(failed.status).toBe(400);
    expect(await keyRows()).toHaveLength(0);

    const ok = await adjust(app, aliceAccount, { token, idempotencyKey, body: adjustment() });
    expect(ok.status).toBe(200);
  });

  it("rolls back the write and stores no key when the handler fails after writing", async () => {
    const { alice, aliceAccount } = await twoUsers();
    const app = adjustedBy(async ({ ctx, input }) => {
      await ctx.tx.update(accounts).set({ balance: 0 }).where(eq(accounts.id, input.id));
      await ctx.tx.insert(transactions).values({ userId: ctx.user.userId, type: "adjustment", amount: 1, accountId: input.id, date: "2026-01-01" });
      throw new DomainError("conflict", "boom");
    });
    const response = await adjust(app, aliceAccount, { token: await tokenFor(alice), idempotencyKey: "rollback-key-0001", body: adjustment() });
    expect(response.status).toBe(409);
    expect(response.body.error?.message).toBe("boom");
    expect((await getAccountRow(aliceAccount))?.balance).toBe(100_000);
    expect(await transactionRows()).toEqual([]);
    expect(await keyRows()).toHaveLength(0);
  });

  it("stores the response as JSON with the key, in the same transaction as the write", async () => {
    const { app, alice, aliceAccount } = await twoUsers();
    const response = await adjust(app, aliceAccount, {
      token: await tokenFor(alice),
      idempotencyKey: "stored-key-0001",
      body: adjustment(1),
    });
    const data = expectOk(response);
    const [record] = await keyRows();
    expect(record).toMatchObject({ userId: alice, key: "stored-key-0001", response: data });
    expect(record?.requestHash).toMatch(/^[0-9a-f]{64}$/);
    const [{ type } = { type: "" }] = await testDb().execute<{ type: string }>(sql`select jsonb_typeof(response) as type from api_idempotency_keys`);
    expect(type).toBe("object");
  });

  it("serializes concurrent requests with one key: one write, the others replay it", async () => {
    const { app, alice, aliceAccount } = await twoUsers();
    const token = await tokenFor(alice);
    const request = { token, idempotencyKey: "race-key-0001", body: adjustment(-100) };
    const responses = await Promise.all(Array.from({ length: 4 }, () => adjust(app, aliceAccount, request)));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(responses.filter((r) => r.headers.get(REPLAYED_HEADER) === "true")).toHaveLength(3);
    expect(new Set(responses.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect((await getAccountRow(aliceAccount))?.balance).toBe(99_900);
    expect(await transactionRows()).toHaveLength(1);
    expect(await keyRows()).toHaveLength(1);
  });

  it("doesn't make different users' writes collide: no serialization retries", async () => {
    const lines: string[] = [];
    const { app } = testApp({ logger: createLogger({ level: "debug", write: (line) => lines.push(line) }) });
    const users = await Promise.all(
      Array.from({ length: 30 }, async () => {
        const user = await seedUser();
        return { account: await seedAccount(user, { balance: 1_000 }), token: await tokenFor(user) };
      }),
    );
    const responses = await Promise.all(
      users.map(({ account, token }, i) =>
        adjust(app, account, { token, idempotencyKey: `many-users-key-${i}`, body: adjustment(-10) }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual(users.map(() => 200));
    // A read of the key table inside SERIALIZABLE would show up here as tx_retry (40001) lines.
    expect(lines.filter((line) => line.includes("tx_retry"))).toEqual([]);
    for (const { account } of users) expect((await getAccountRow(account))?.balance).toBe(990);
    expect(await keyRows()).toHaveLength(users.length);
  });

  it("serializes concurrent creates with one key: one row, the others replay it", async () => {
    const { app, alice } = await twoUsers();
    const request = {
      token: await tokenFor(alice),
      idempotencyKey: "race-create-key-0001",
      body: { name: "Savings", type: "savings", balance: { amountMinor: 0, currency: "USD" } },
    };
    const responses = await Promise.all(Array.from({ length: 5 }, () => create(app, request)));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(responses.filter((r) => r.headers.get(REPLAYED_HEADER) === "true")).toHaveLength(4);
    expect(new Set(responses.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(await testDb().select().from(accounts).where(eq(accounts.userId, alice))).toHaveLength(2);
  });

  it("answers conflict to concurrent requests with one key and different bodies, writing once", async () => {
    const { app, alice, aliceAccount } = await twoUsers();
    const token = await tokenFor(alice);
    const responses = await Promise.all(
      [1, 2, 3, 4].map((n) => adjust(app, aliceAccount, { token, idempotencyKey: "diff-race-0001", body: adjustment(-n) })),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect(await transactionRows()).toHaveLength(1);
  });

  it("lets a request waiting on the key run when the first one fails", async () => {
    const { alice, aliceAccount } = await twoUsers();
    let calls = 0;
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => (entered = resolve));
    const app = adjustedBy(async (options) => {
      if (++calls === 1) {
        entered();
        await new Promise((resolve) => setTimeout(resolve, 200));
        throw new DomainError("conflict", "first fails");
      }
      return await realAdjust(options);
    });
    const request = { token: await tokenFor(alice), idempotencyKey: "fail-first-0001", body: adjustment(-100) };
    const first = adjust(app, aliceAccount, request);
    await firstEntered;
    const second = await adjust(app, aliceAccount, request);
    expect((await first).status).toBe(409);
    expect(second.status).toBe(200);
    expect(second.headers.get(REPLAYED_HEADER)).toBeNull();
    expect((await getAccountRow(aliceAccount))?.balance).toBe(99_900);
  });

  it("re-executes an expired key once when requests race for it", async () => {
    const { app, alice, aliceAccount } = await twoUsers();
    const token = await tokenFor(alice);
        await adjust(app, aliceAccount, { token, idempotencyKey: "expired-race-0001", body: adjustment(-100) });
    await testDb().update(apiIdempotencyKeys).set({ createdAt: new Date(Date.now() - IDEMPOTENCY_TTL_MS - 1000) });
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => adjust(app, aliceAccount, { token, idempotencyKey: "expired-race-0001", body: adjustment(-7) })),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(responses.filter((r) => r.headers.get(REPLAYED_HEADER) === "true")).toHaveLength(4);
    expect((await getAccountRow(aliceAccount))?.balance).toBe(100_000 - 100 - 7);
    expect(await keyRows()).toHaveLength(1);
  });

  it("re-executes a key older than the TTL even before the purge runs", async () => {
    const { app, alice, aliceAccount } = await twoUsers();
    const token = await tokenFor(alice);
        const request = { token, idempotencyKey: "expired-key-0001", body: adjustment(-1_000) };
    await adjust(app, aliceAccount, request);
    await testDb().update(apiIdempotencyKeys).set({ createdAt: new Date(Date.now() - IDEMPOTENCY_TTL_MS - 1000) });

    const again = await adjust(app, aliceAccount, { ...request, body: adjustment(-3_000) });
    expect(again.status).toBe(200);
    expect(again.headers.get(REPLAYED_HEADER)).toBeNull();
    expect((await getAccountRow(aliceAccount))?.balance).toBe(100_000 - 1_000 - 3_000);
    expect(await keyRows()).toHaveLength(1);
  });

  it("keeps no record for reads", async () => {
    const { app, alice } = await twoUsers();
    const response = await raw(app, "accounts.list", {}, { token: await tokenFor(alice), idempotencyKey: "read-key-0001" });
    expect(response.status).toBe(200);
    expect(response.headers.get(REPLAYED_HEADER)).toBeNull();
    expect(await keyRows()).toHaveLength(0);
  });

  it("purges keys older than the TTL, one batch per call", async () => {
    const user = await createTestUser();
    const now = Date.now();
    const rows = [
      ["old-key-0001", IDEMPOTENCY_TTL_MS + 1],
      ["old-key-0002", IDEMPOTENCY_TTL_MS + 5_000],
      ["new-key-0001", 1_000],
    ] as const;
    await testDb()
      .insert(apiIdempotencyKeys)
      .values(rows.map(([key, age]) => ({ userId: user, key, requestHash: "h", response: {}, createdAt: new Date(now - age) })));

    expect(await purgeExpiredIdempotencyKeys(testDb(), { now, batch: 1 })).toBe(1);
    expect(await purgeExpiredIdempotencyKeys(testDb(), { now, batch: 1 })).toBe(1);
    expect(await purgeExpiredIdempotencyKeys(testDb(), { now, batch: 1 })).toBe(0);
    expect((await keyRows()).map((r) => r.key)).toEqual(["new-key-0001"]);
  });
});
