import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { testDb } from "../../test/db";
import { accounts, categories } from "./schema";
import { isRetryableTxError, withTx } from "./tx";

/** Resolves once `count` callers have arrived. Only the first attempt of each transaction waits. */
function barrier(count: number) {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((resolve) => (release = resolve));
  return () => {
    arrived += 1;
    if (arrived === count) release();
    return all;
  };
}

const raise = (sqlstate: string) =>
  sql.raw(`do $$ begin raise exception 'simulated' using errcode = '${sqlstate}'; end $$`);

describe("withTx", () => {
  it("runs the callback in a SERIALIZABLE transaction and returns its result", async () => {
    const level = await withTx(testDb(), async (tx) => {
      const [row] = await tx.execute<{ level: string }>(sql`select current_setting('transaction_isolation') as level`);
      return row!.level;
    });
    expect(level).toBe("serializable");
  });

  it("rolls back when the callback throws", async () => {
    const userId = randomUUID();
    await expect(
      withTx(testDb(), async (tx) => {
        await tx.insert(accounts).values({ userId, name: "Cash", type: "cash", balance: 0, currency: "USD" });
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(await testDb().select().from(accounts).where(eq(accounts.userId, userId))).toEqual([]);
  });

  it("retries a lost update between two concurrent transactions until both apply", async () => {
    const userId = randomUUID();
    const [account] = await testDb()
      .insert(accounts)
      .values({ userId, name: "Bank", type: "bank", balance: 1_000, currency: "USD" })
      .returning();
    const bothRead = barrier(2);
    const attempts = { a: 0, b: 0 };

    // Read, wait until the other transaction has read the same balance, then write: a classic lost update.
    const deposit = (name: "a" | "b", amount: number) =>
      withTx(testDb(), async (tx) => {
        attempts[name] += 1;
        const [row] = await tx.select().from(accounts).where(eq(accounts.id, account!.id));
        if (attempts[name] === 1) await bothRead();
        await tx
          .update(accounts)
          .set({ balance: row!.balance + amount })
          .where(eq(accounts.id, account!.id));
      });

    await Promise.all([deposit("a", 50), deposit("b", 7)]);

    const [after] = await testDb().select().from(accounts).where(eq(accounts.id, account!.id));
    expect(after!.balance).toBe(1_057);
    // One of them hit 40001 and ran again on the committed balance.
    expect(attempts.a + attempts.b).toBe(3);
  });

  it("retries write skew (no shared row) so a check-then-insert rule holds", async () => {
    // "At most one expense category named Food per user", enforced only in code, as Convex did.
    const userId = randomUUID();
    const bothChecked = barrier(2);
    const attempts = { a: 0, b: 0 };
    const createOnce = (name: "a" | "b") =>
      withTx(testDb(), async (tx) => {
        attempts[name] += 1;
        const existing = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(and(eq(categories.userId, userId), eq(categories.name, "Food")));
        if (attempts[name] === 1) await bothChecked();
        if (existing.length > 0) return "exists" as const;
        await tx.insert(categories).values({ userId, name: "Food", type: "expense" });
        return "created" as const;
      });

    const results = await Promise.all([createOnce("a"), createOnce("b")]);

    expect(results.sort()).toEqual(["created", "exists"]);
    const rows = await testDb().select().from(categories).where(eq(categories.userId, userId));
    expect(rows).toHaveLength(1);
    expect(attempts.a + attempts.b).toBe(3);
  });

  it("retries a deadlock", async () => {
    const userId = randomUUID();
    let attempts = 0;
    await withTx(testDb(), async (tx) => {
      attempts += 1;
      if (attempts === 1) await tx.execute(raise("40P01"));
      await tx.insert(accounts).values({ userId, name: "Cash", type: "cash", balance: 0, currency: "USD" });
    });
    expect(attempts).toBe(2);
    expect(await testDb().select().from(accounts).where(eq(accounts.userId, userId))).toHaveLength(1);
  });

  it("gives up after maxAttempts and rethrows the serialization failure", async () => {
    let attempts = 0;
    const retries: number[] = [];
    const error = await withTx(
      testDb(),
      async (tx) => {
        attempts += 1;
        await tx.execute(raise("40001"));
      },
      { maxAttempts: 3, onRetry: ({ attempt }) => retries.push(attempt) },
    ).catch((e: unknown) => e);

    expect(attempts).toBe(3);
    expect(retries).toEqual([1, 2]);
    expect(isRetryableTxError(error)).toBe(true);
  });

  it("does not retry other errors", async () => {
    let attempts = 0;
    const error = await withTx(testDb(), async (tx) => {
      attempts += 1;
      await tx.execute(raise("23505"));
    }).catch((e: unknown) => e);
    expect(attempts).toBe(1);
    expect(isRetryableTxError(error)).toBe(false);
  });

  it("surfaces a deferred foreign key violation raised at commit, without retrying", async () => {
    const error = await withTx(testDb(), async (tx) => {
      await tx.insert(accounts).values({ userId: randomUUID(), name: "x", type: "cash", balance: 0, currency: "USD" });
      await tx.execute(sql`insert into subcategories (user_id, category_id, name, sort_order) values (${randomUUID()}, ${randomUUID()}, 'x', 0)`);
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isRetryableTxError(error)).toBe(false);
    expect(await testDb().select().from(accounts)).toEqual([]);
  });
});
