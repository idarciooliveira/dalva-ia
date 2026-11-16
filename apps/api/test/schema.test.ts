/** Database-level rules of the schema: id generation, type mapping, uniqueness, foreign keys. */
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  accounts,
  apiIdempotencyKeys,
  categories,
  channelIdentities,
  channelLinkCodes,
  debtPayments,
  debts,
  goalContributions,
  savingsGoals,
  transactions,
  userProfiles,
} from "../src/db/schema";
import { sqlState, withTx } from "../src/db/tx";
import { testDb } from "./db";

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected the statement to fail");
    },
    (error: unknown) => sqlState(error),
  );

async function account(userId = randomUUID(), balance = 0) {
  const [row] = await testDb()
    .insert(accounts)
    .values({ userId, name: "Bank", type: "bank", balance, currency: "USD" })
    .returning();
  return row!;
}

describe("ids and types", () => {
  it("generates UUIDv7 ids that sort by creation", async () => {
    const first = await account();
    const second = await account();
    const [row] = await testDb().execute<{ version: number }>(sql`select uuid_extract_version(${first.id}::uuid) as version`);
    expect(row!.version).toBe(7);
    expect(first.id < second.id).toBe(true);
  });

  it("reads money as numbers, calendar dates as strings and instants as Dates", async () => {
    const acct = await account(randomUUID(), 2 ** 40);
    expect(acct.balance).toBe(2 ** 40);
    expect(acct.archived).toBe(false);
    expect(acct.createdAt).toBeInstanceOf(Date);

    const [tx] = await testDb()
      .insert(transactions)
      .values({ userId: acct.userId, type: "adjustment", amount: -150, accountId: acct.id, date: "2026-04-05" })
      .returning();
    expect(tx).toMatchObject({ amount: -150, date: "2026-04-05", tags: null });

    const [goal] = await testDb()
      .insert(savingsGoals)
      .values({ userId: acct.userId, name: "Trip", targetAmount: 100_000, isVirtual: true })
      .returning();
    expect(goal!.currentAmount).toBe(0);
    expect(goal!.createdOn).toBe(new Date().toISOString().slice(0, 10));
  });

  it("rejects values outside an enum", async () => {
    const code = await failure(
      testDb().execute(sql`insert into accounts (user_id, name, type, balance, currency) values (${randomUUID()}, 'x', 'crypto', 0, 'USD')`),
    );
    expect(code).toBe("22P02");
  });

  it("round-trips channel scope arrays", async () => {
    const [row] = await testDb()
      .insert(channelIdentities)
      .values({
        userId: randomUUID(),
        channel: "telegram",
        externalUserId: "42",
        chatId: "42",
        scopes: ["finance:read", "finance:write"],
        linkedAt: new Date(),
        consentAt: new Date(),
      })
      .returning();
    const [read] = await testDb().select().from(channelIdentities).where(eq(channelIdentities.id, row!.id));
    expect(read!.scopes).toEqual(["finance:read", "finance:write"]);
  });
});

describe("uniqueness", () => {
  const identity = (overrides: Partial<typeof channelIdentities.$inferInsert> = {}) => ({
    userId: randomUUID(),
    channel: "telegram" as const,
    externalUserId: "1001",
    chatId: "1001",
    scopes: ["finance:read" as const],
    linkedAt: new Date(),
    consentAt: new Date(),
    ...overrides,
  });

  it("allows one active identity per chat account, any number of unlinked ones", async () => {
    const [first] = await testDb().insert(channelIdentities).values(identity()).returning();
    expect(await failure(testDb().insert(channelIdentities).values(identity()))).toBe("23505");

    await testDb().update(channelIdentities).set({ unlinkedAt: new Date() }).where(eq(channelIdentities.id, first!.id));
    await testDb().insert(channelIdentities).values(identity());
    await testDb().insert(channelIdentities).values(identity({ unlinkedAt: new Date() }));
  });

  it("allows one active identity per user and channel", async () => {
    const userId = randomUUID();
    await testDb().insert(channelIdentities).values(identity({ userId, externalUserId: "1", chatId: "1" }));
    expect(
      await failure(testDb().insert(channelIdentities).values(identity({ userId, externalUserId: "2", chatId: "2" }))),
    ).toBe("23505");
  });

  it("keeps link code hashes unique, and one code per user and channel", async () => {
    const code = (userId: string, codeHash: string) => ({
      userId,
      channel: "telegram" as const,
      codeHash,
      expiresAt: new Date(Date.now() + 600_000),
      consentAt: new Date(),
    });
    const userId = randomUUID();
    await testDb().insert(channelLinkCodes).values(code(userId, "a".repeat(64)));
    expect(await failure(testDb().insert(channelLinkCodes).values(code(randomUUID(), "a".repeat(64))))).toBe("23505");
    expect(await failure(testDb().insert(channelLinkCodes).values(code(userId, "b".repeat(64))))).toBe("23505");
  });

  it("scopes idempotency keys per user", async () => {
    const row = (userId: string) => ({ userId, key: "key-12345", requestHash: "h", response: { id: "x" } });
    const userId = randomUUID();
    await testDb().insert(apiIdempotencyKeys).values(row(userId));
    await testDb().insert(apiIdempotencyKeys).values(row(randomUUID()));
    expect(await failure(testDb().insert(apiIdempotencyKeys).values(row(userId)))).toBe("23505");
  });

  it("allows one profile per user", async () => {
    const userId = randomUUID();
    await testDb().insert(userProfiles).values({ userId, baseCurrency: "USD" });
    expect(await failure(testDb().insert(userProfiles).values({ userId, baseCurrency: "EUR" }))).toBe("23505");
  });
});

describe("foreign keys", () => {
  it("declares every key between domain tables DEFERRABLE INITIALLY DEFERRED", async () => {
    const rows = await testDb().execute<{ name: string; deferrable: boolean; deferred: boolean }>(sql`
      select conname as name, condeferrable as deferrable, condeferred as deferred
      from pg_constraint
      where contype = 'f' and connamespace = 'public'::regnamespace and confdeltype in ('a', 'n')
      order by conname
    `);
    expect(rows.length).toBeGreaterThanOrEqual(14);
    expect(rows.filter((row) => !row.deferrable || !row.deferred).map((row) => row.name)).toEqual([]);
  });

  it("lets a transfer's legs reference each other and be deleted in either order", async () => {
    const userId = randomUUID();
    const from = await account(userId);
    const to = await account(userId);
    const transferGroupId = randomUUID();

    const { outgoingId, incomingId } = await withTx(testDb(), async (tx) => {
      // Same order as Convex: outgoing first, linked to the incoming leg afterwards.
      const outgoingId = randomUUID();
      const incomingId = randomUUID();
      await tx.insert(transactions).values({
        id: outgoingId,
        userId,
        type: "transfer",
        amount: 500,
        accountId: from.id,
        destinationAccountId: to.id,
        linkedTransactionId: incomingId,
        transferGroupId,
        date: "2026-04-05",
      });
      await tx.insert(transactions).values({
        id: incomingId,
        userId,
        type: "transfer",
        amount: 500,
        accountId: to.id,
        linkedTransactionId: outgoingId,
        transferGroupId,
        date: "2026-04-05",
      });
      return { outgoingId, incomingId };
    });

    await withTx(testDb(), async (tx) => {
      await tx.delete(transactions).where(eq(transactions.id, outgoingId));
      await tx.delete(transactions).where(eq(transactions.id, incomingId));
    });
    expect(await testDb().select().from(transactions)).toEqual([]);
  });

  it("refuses, at commit, to delete one leg alone or an account still in use", async () => {
    const userId = randomUUID();
    const acct = await account(userId);
    const [tx] = await testDb()
      .insert(transactions)
      .values({ userId, type: "income", amount: 1, accountId: acct.id, date: "2026-04-05" })
      .returning();
    await testDb().insert(transactions).values({
      userId,
      type: "transfer",
      amount: 1,
      accountId: acct.id,
      linkedTransactionId: tx!.id,
      date: "2026-04-05",
    });

    expect(await failure(withTx(testDb(), (t) => t.delete(accounts).where(eq(accounts.id, acct.id))))).toBe("23503");
    expect(await failure(withTx(testDb(), (t) => t.delete(transactions).where(eq(transactions.id, tx!.id))))).toBe("23503");
  });

  it("lets a debt payment be deleted after its transactions, as the Convex code does", async () => {
    const userId = randomUUID();
    const acct = await account(userId);
    const [debt] = await testDb()
      .insert(debts)
      .values({ userId, name: "Loan", debtType: "loan", originalAmount: 1_000, currentBalance: 900 })
      .returning();
    const [source] = await testDb()
      .insert(transactions)
      .values({ userId, type: "expense", amount: 100, accountId: acct.id, date: "2026-04-05" })
      .returning();
    const [payment] = await testDb()
      .insert(debtPayments)
      .values({
        userId,
        debtId: debt!.id,
        amount: 100,
        principalAmount: 100,
        interestAmount: 0,
        date: "2026-04-05",
        fromAccountId: acct.id,
        sourceTransactionId: source!.id,
      })
      .returning();

    await withTx(testDb(), async (tx) => {
      await tx.delete(transactions).where(eq(transactions.id, source!.id));
      await tx.delete(debtPayments).where(eq(debtPayments.id, payment!.id));
    });
    expect(await testDb().select().from(debtPayments)).toEqual([]);
  });

  it("accepts null for references Convex left dangling (legacy rows)", async () => {
    const [debt] = await testDb()
      .insert(debts)
      .values({ userId: randomUUID(), name: "Loan", debtType: "loan", originalAmount: 1_000, currentBalance: 900 })
      .returning();
    await testDb()
      .insert(transactions)
      .values({ userId: randomUUID(), type: "expense", amount: 5, accountId: null, date: "2026-01-02" });
    await testDb().insert(debtPayments).values({
      userId: debt!.userId,
      debtId: debt!.id,
      amount: 100,
      principalAmount: 100,
      interestAmount: 0,
      date: "2026-01-02",
      fromAccountId: null,
      sourceTransactionId: null,
    });
  });

  it("checks references at commit, so rows can be inserted before what they point at", async () => {
    const userId = randomUUID();
    const accountId = randomUUID();
    const categoryId = randomUUID();
    await withTx(testDb(), async (tx) => {
      await tx
        .insert(transactions)
        .values({ userId, type: "expense", amount: 5, accountId, categoryId, date: "2026-01-02" });
      await tx.insert(categories).values({ id: categoryId, userId, name: "Food", type: "expense" });
      await tx.insert(accounts).values({ id: accountId, userId, name: "Bank", type: "bank", balance: 0, currency: "USD" });
    });
    expect(await testDb().select().from(transactions)).toHaveLength(1);
  });

  it("nulls the category of transactions when the category is deleted", async () => {
    const userId = randomUUID();
    const acct = await account(userId);
    const [category] = await testDb().insert(categories).values({ userId, name: "Food", type: "expense" }).returning();
    const [tx] = await testDb()
      .insert(transactions)
      .values({ userId, type: "expense", amount: 1, accountId: acct.id, categoryId: category!.id, date: "2026-04-05" })
      .returning();

    await testDb().delete(categories).where(eq(categories.id, category!.id));
    const [after] = await testDb().select().from(transactions).where(eq(transactions.id, tx!.id));
    expect(after!.categoryId).toBeNull();
  });

  it("nulls a goal contribution's transaction when the transfer is deleted on its own", async () => {
    const userId = randomUUID();
    const acct = await account(userId);
    const [goal] = await testDb()
      .insert(savingsGoals)
      .values({ userId, name: "Trip", targetAmount: 1_000, isVirtual: false, linkedAccountId: acct.id })
      .returning();
    const [tx] = await testDb()
      .insert(transactions)
      .values({ userId, type: "transfer", amount: 10, accountId: acct.id, date: "2026-04-05" })
      .returning();
    const [contribution] = await testDb()
      .insert(goalContributions)
      .values({ userId, goalId: goal!.id, amount: 10, date: "2026-04-05", transactionId: tx!.id })
      .returning();

    await testDb().delete(transactions).where(eq(transactions.id, tx!.id));
    const [after] = await testDb().select().from(goalContributions).where(eq(goalContributions.id, contribution!.id));
    expect(after!.transactionId).toBeNull();
  });
});
