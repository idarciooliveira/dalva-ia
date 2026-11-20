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
  subcategories,
  transactions,
  userProfiles,
  users,
} from "../src/db/schema";
import { sqlState, withTx } from "../src/db/tx";
import { createTestUser } from "./app";
import { testDb } from "./db";

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected the statement to fail");
    },
    (error: unknown) => sqlState(error),
  );

/** The constraint a failed statement violated. */
const violated = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected the statement to fail");
    },
    (error: unknown) => {
      for (let current = error; current instanceof Error; current = current.cause) {
        const name = (current as { constraint_name?: string }).constraint_name;
        if (name) return name;
      }
      return undefined;
    },
  );

async function account(userId?: string, balance = 0) {
  userId ??= await createTestUser();
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
    const acct = await account(undefined, 2 ** 40);
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
      testDb().execute(sql`insert into accounts (user_id, name, type, balance, currency) values (${await createTestUser()}, 'x', 'crypto', 0, 'USD')`),
    );
    expect(code).toBe("22P02");
  });

  it("round-trips channel scope arrays", async () => {
    const [row] = await testDb()
      .insert(channelIdentities)
      .values({
        userId: await createTestUser(),
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
  const identity = (userId: string, overrides: Partial<typeof channelIdentities.$inferInsert> = {}) => ({
    userId,
    channel: "telegram" as const,
    externalUserId: "1001",
    chatId: "1001",
    scopes: ["finance:read" as const],
    linkedAt: new Date(),
    consentAt: new Date(),
    ...overrides,
  });

  it("allows one active identity per chat account, any number of unlinked ones", async () => {
    const [a, b, c, d] = await Promise.all([createTestUser(), createTestUser(), createTestUser(), createTestUser()]);
    const [first] = await testDb().insert(channelIdentities).values(identity(a)).returning();
    expect(await failure(testDb().insert(channelIdentities).values(identity(b)))).toBe("23505");

    await testDb().update(channelIdentities).set({ unlinkedAt: new Date() }).where(eq(channelIdentities.id, first!.id));
    await testDb().insert(channelIdentities).values(identity(c));
    await testDb().insert(channelIdentities).values(identity(d, { unlinkedAt: new Date() }));
  });

  it("allows one active identity per user and channel", async () => {
    const userId = await createTestUser();
    await testDb().insert(channelIdentities).values(identity(userId, { externalUserId: "1", chatId: "1" }));
    expect(
      await failure(testDb().insert(channelIdentities).values(identity(userId, { externalUserId: "2", chatId: "2" }))),
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
    const userId = await createTestUser();
    await testDb().insert(channelLinkCodes).values(code(userId, "a".repeat(64)));
    expect(await failure(testDb().insert(channelLinkCodes).values(code(await createTestUser(), "a".repeat(64))))).toBe("23505");
    expect(await failure(testDb().insert(channelLinkCodes).values(code(userId, "b".repeat(64))))).toBe("23505");
  });

  it("scopes idempotency keys per user", async () => {
    const row = (userId: string) => ({ userId, key: "key-12345", requestHash: "h", response: { id: "x" } });
    const userId = await createTestUser();
    await testDb().insert(apiIdempotencyKeys).values(row(userId));
    await testDb().insert(apiIdempotencyKeys).values(row(await createTestUser()));
    expect(await failure(testDb().insert(apiIdempotencyKeys).values(row(userId)))).toBe("23505");
  });

  it("allows one profile per user", async () => {
    const userId = await createTestUser();
    await testDb().insert(userProfiles).values({ userId, baseCurrency: "USD" });
    expect(await failure(testDb().insert(userProfiles).values({ userId, baseCurrency: "EUR" }))).toBe("23505");
  });
});

describe("foreign keys", () => {
  it("lets a transfer's legs reference each other and be deleted in either order", async () => {
    const userId = await createTestUser();
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
    const userId = await createTestUser();
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
    const userId = await createTestUser();
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
      .values({ userId: await createTestUser(), name: "Loan", debtType: "loan", originalAmount: 1_000, currentBalance: 900 })
      .returning();
    await testDb()
      .insert(transactions)
      .values({ userId: debt!.userId, type: "expense", amount: 5, accountId: null, date: "2026-01-02" });
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
    const userId = await createTestUser();
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
    const userId = await createTestUser();
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
    const userId = await createTestUser();
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

describe("user isolation", () => {
  // Targets of cross-row references, created for a given user.
  const make = {
    account: async (userId: string) => (await account(userId)).id,
    category: async (userId: string) =>
      (await testDb().insert(categories).values({ userId, name: "Food", type: "expense" }).returning())[0]!.id,
    subcategory: async (userId: string) =>
      (
        await testDb()
          .insert(subcategories)
          .values({ userId, categoryId: await make.category(userId), name: "Lunch", sortOrder: 0 })
          .returning()
      )[0]!.id,
    transaction: async (userId: string) =>
      (
        await testDb()
          .insert(transactions)
          .values({ userId, type: "expense", amount: 1, date: "2026-04-05" })
          .returning()
      )[0]!.id,
    goal: async (userId: string) =>
      (
        await testDb()
          .insert(savingsGoals)
          .values({ userId, name: "Trip", targetAmount: 1_000, isVirtual: true })
          .returning()
      )[0]!.id,
    debt: async (userId: string) =>
      (
        await testDb()
          .insert(debts)
          .values({ userId, name: "Loan", debtType: "loan", originalAmount: 1_000, currentBalance: 1_000 })
          .returning()
      )[0]!.id,
  };

  const transaction = (column: keyof typeof transactions.$inferInsert) => async (userId: string, id: string) => {
    await testDb()
      .insert(transactions)
      .values({ userId, type: "transfer", amount: 1, date: "2026-04-05", [column]: id });
  };
  const contribution = (column: "goalId" | "transactionId") => async (userId: string, id: string) => {
    const goalId = column === "goalId" ? id : await make.goal(userId);
    await testDb()
      .insert(goalContributions)
      .values({ userId, goalId, amount: 10, date: "2026-04-05", [column]: id });
  };
  const payment = (column: "debtId" | "fromAccountId" | "sourceTransactionId" | "liabilityTransactionId") =>
    async (userId: string, id: string) => {
      const debtId = column === "debtId" ? id : await make.debt(userId);
      await testDb()
        .insert(debtPayments)
        .values({ userId, debtId, amount: 10, principalAmount: 10, interestAmount: 0, date: "2026-04-05", [column]: id });
    };

  // Every composite key: the target it points at and an insert of a row of `userId` pointing at `id`.
  const keys: { name: string; target: keyof typeof make; insert: (userId: string, id: string) => Promise<void> }[] = [
    {
      name: "subcategories_category_id_fk",
      target: "category",
      insert: async (userId, categoryId) => {
        await testDb().insert(subcategories).values({ userId, categoryId, name: "Lunch", sortOrder: 0 });
      },
    },
    { name: "transactions_account_id_fk", target: "account", insert: transaction("accountId") },
    { name: "transactions_category_id_fk", target: "category", insert: transaction("categoryId") },
    { name: "transactions_subcategory_id_fk", target: "subcategory", insert: transaction("subcategoryId") },
    { name: "transactions_destination_account_id_fk", target: "account", insert: transaction("destinationAccountId") },
    { name: "transactions_linked_transaction_id_fk", target: "transaction", insert: transaction("linkedTransactionId") },
    {
      name: "savings_goals_linked_account_id_fk",
      target: "account",
      insert: async (userId, linkedAccountId) => {
        await testDb()
          .insert(savingsGoals)
          .values({ userId, name: "Trip", targetAmount: 1_000, isVirtual: false, linkedAccountId });
      },
    },
    { name: "goal_contributions_goal_id_fk", target: "goal", insert: contribution("goalId") },
    { name: "goal_contributions_transaction_id_fk", target: "transaction", insert: contribution("transactionId") },
    {
      name: "debts_linked_account_id_fk",
      target: "account",
      insert: async (userId, linkedAccountId) => {
        await testDb()
          .insert(debts)
          .values({ userId, name: "Loan", debtType: "loan", originalAmount: 1, currentBalance: 1, linkedAccountId });
      },
    },
    { name: "debt_payments_debt_id_fk", target: "debt", insert: payment("debtId") },
    { name: "debt_payments_from_account_id_fk", target: "account", insert: payment("fromAccountId") },
    { name: "debt_payments_source_transaction_id_fk", target: "transaction", insert: payment("sourceTransactionId") },
    { name: "debt_payments_liability_transaction_id_fk", target: "transaction", insert: payment("liabilityTransactionId") },
  ];

  it("makes every key between domain rows (id, user_id), deferred, with SET NULL on the id only", async () => {
    const rows = await testDb().execute<{
      name: string;
      columns: string;
      target: string;
      on_delete: string;
      on_update: string;
      match: string;
      deferred: boolean;
      set_null: string | null;
    }>(sql`
      select c.conname as name,
        (select string_agg(a.attname, ',' order by k.n) from unnest(c.conkey) with ordinality k(attnum, n)
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as columns,
        (select string_agg(a.attname, ',' order by k.n) from unnest(c.confkey) with ordinality k(attnum, n)
          join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as target,
        (select string_agg(a.attname, ',') from unnest(c.confdelsetcols) k(attnum)
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as set_null,
        c.confdeltype as on_delete, c.confupdtype as on_update, c.confmatchtype as match,
        c.condeferrable and c.condeferred as deferred
      from pg_constraint c
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace and c.confrelid <> 'users'::regclass
      order by c.conname
    `);
    expect(rows.map((row) => row.name)).toEqual(keys.map((key) => key.name).sort());

    // Same ON DELETE as before: these three nulled the reference, the others refuse the delete at commit.
    const nulled = new Set(["transactions_category_id_fk", "transactions_subcategory_id_fk", "goal_contributions_transaction_id_fk"]);
    for (const row of rows) {
      const [column] = row.columns.split(",");
      expect(row).toEqual({
        name: row.name,
        columns: `${column},user_id`,
        target: "id,user_id",
        on_delete: nulled.has(row.name) ? "n" : "a",
        on_update: "a",
        match: "s",
        deferred: true,
        set_null: nulled.has(row.name) ? column : null,
      });
    }
  });

  for (const key of keys) {
    it(`${key.name}: refuses another user's ${key.target}, accepts the owner's`, async () => {
      const [owner, other] = await Promise.all([createTestUser(), createTestUser()]);
      const target = await make[key.target](owner);
      expect(await violated(key.insert(other, target))).toBe(key.name);
      await key.insert(owner, target);
    });
  }

  it("refuses to move a row to another user while the owner's rows point at it", async () => {
    const [owner, other] = await Promise.all([createTestUser(), createTestUser()]);
    const accountId = await make.account(owner);
    await transaction("accountId")(owner, accountId);
    expect(await failure(testDb().update(accounts).set({ userId: other }).where(eq(accounts.id, accountId)))).toBe("23503");
    // And the other way: a row can't move to another user while it points at the owner's row.
    expect(await failure(testDb().update(transactions).set({ userId: other }))).toBe("23503");
  });

  it("nulls a deleted subcategory on transactions and keeps the owner", async () => {
    const userId = await createTestUser();
    const subcategoryId = await make.subcategory(userId);
    await transaction("subcategoryId")(userId, subcategoryId);

    await testDb().delete(subcategories).where(eq(subcategories.id, subcategoryId));
    const [after] = await testDb().select().from(transactions);
    expect(after).toMatchObject({ userId, subcategoryId: null });
  });
});

describe("users", () => {
  it("refuses to delete a user who still owns finance data", async () => {
    const userId = await createTestUser();
    await account(userId);
    expect(await failure(testDb().delete(users).where(eq(users.id, userId)))).toBe("23001");
  });

  it("refuses rows for a user that doesn't exist", async () => {
    expect(await failure(account(randomUUID()))).toBe("23503");
  });

  it("stores emails lowercase only", async () => {
    expect(await failure(createTestUser("Someone@Example.com"))).toBe("23514");
  });
});
