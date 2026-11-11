import { describe, expect, it } from "vitest";
import type { Id } from "./_generated/dataModel";
import * as accounts from "./domain/accounts";
import * as categories from "./domain/categories";
import * as transactions from "./domain/transactions";
import * as transfers from "./domain/transfers";
import { setupTest } from "./test.setup";

const ALICE = "alice-domain";
const BOB = "bob-domain";

type T = ReturnType<typeof setupTest>;

async function seedAccount(t: T, userId: string, balance = 10000) {
  return await t.run((ctx) =>
    accounts.createAccount(ctx, userId, {
      name: "Checking",
      type: "bank",
      balance,
      currency: "USD",
    }),
  );
}

async function seedCategory(t: T, userId: string, name = "Food") {
  return await t.run((ctx) =>
    categories.createCategory(ctx, userId, {
      name,
      type: "expense",
      icon: "x",
      color: "#fff",
    }),
  );
}

async function balanceOf(t: T, id: Id<"accounts">) {
  return (await t.run((ctx) => ctx.db.get(id)))?.balance;
}

describe("domain/transactions", () => {
  it("creates income/expense transactions and updates balances", async () => {
    const t = setupTest();
    const accountId = await seedAccount(t, ALICE);
    const categoryId = await seedCategory(t, ALICE);

    const expenseId = await t.run((ctx) =>
      transactions.createTransaction(ctx, ALICE, {
        type: "expense",
        amount: 1500,
        accountId,
        categoryId,
        date: "2026-03-10",
        description: "Lunch",
      }),
    );
    await t.run((ctx) =>
      transactions.createTransaction(ctx, ALICE, {
        type: "income",
        amount: 5000,
        accountId,
        date: "2026-03-11",
      }),
    );

    expect(await balanceOf(t, accountId)).toBe(10000 - 1500 + 5000);
    expect(await t.run((ctx) => ctx.db.get(expenseId))).toMatchObject({
      userId: ALICE,
      type: "expense",
      amount: 1500,
      categoryId,
      description: "Lunch",
    });
  });

  it("rejects categories/subcategories on adjustments (create and update)", async () => {
    const t = setupTest();
    const accountId = await seedAccount(t, ALICE);
    const categoryId = await seedCategory(t, ALICE);

    await expect(
      t.run((ctx) =>
        transactions.createTransaction(ctx, ALICE, {
          type: "adjustment",
          amount: 100,
          accountId,
          categoryId,
          date: "2026-03-10",
        }),
      ),
    ).rejects.toThrow("Adjustments cannot have a category");

    const expenseId = await t.run((ctx) =>
      transactions.createTransaction(ctx, ALICE, {
        type: "expense",
        amount: 100,
        accountId,
        categoryId,
        date: "2026-03-10",
      }),
    );
    await expect(
      t.run((ctx) =>
        transactions.updateTransaction(ctx, ALICE, { id: expenseId, type: "adjustment" }),
      ),
    ).rejects.toThrow("Adjustments cannot have a category");
  });

  it("update reverses the old balance effect and applies the new one", async () => {
    const t = setupTest();
    const first = await seedAccount(t, ALICE, 10000);
    const second = await seedAccount(t, ALICE, 2000);
    const id = await t.run((ctx) =>
      transactions.createTransaction(ctx, ALICE, {
        type: "expense",
        amount: 1000,
        accountId: first,
        date: "2026-03-10",
      }),
    );
    expect(await balanceOf(t, first)).toBe(9000);

    await t.run((ctx) =>
      transactions.updateTransaction(ctx, ALICE, {
        id,
        type: "income",
        amount: 400,
        accountId: second,
        note: "moved",
      }),
    );
    expect(await balanceOf(t, first)).toBe(10000);
    expect(await balanceOf(t, second)).toBe(2400);
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      type: "income",
      amount: 400,
      accountId: second,
      note: "moved",
    });
  });

  it("delete reverses the balance effect", async () => {
    const t = setupTest();
    const accountId = await seedAccount(t, ALICE);
    const id = await t.run((ctx) =>
      transactions.createTransaction(ctx, ALICE, {
        type: "expense",
        amount: 1000,
        accountId,
        date: "2026-03-10",
      }),
    );
    await t.run((ctx) => transactions.deleteTransaction(ctx, ALICE, { id }));
    expect(await balanceOf(t, accountId)).toBe(10000);
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
  });

  it("lists with filters, ordering and limit", async () => {
    const t = setupTest();
    const accountId = await seedAccount(t, ALICE);
    for (const [date, type] of [
      ["2026-01-01", "income"],
      ["2026-02-01", "expense"],
      ["2026-03-01", "expense"],
    ] as const) {
      await t.run((ctx) =>
        transactions.createTransaction(ctx, ALICE, { type, amount: 100, accountId, date }),
      );
    }
    const all = await t.run((ctx) => transactions.listTransactions(ctx, ALICE, {}));
    expect(all.page.map((x) => x.date)).toEqual(["2026-03-01", "2026-02-01", "2026-01-01"]);
    expect(all).toMatchObject({ isDone: true, continueCursor: null });

    const filtered = await t.run((ctx) =>
      transactions.listTransactions(ctx, ALICE, {
        type: "expense",
        dateFrom: "2026-02-01",
        paginationOpts: { numItems: 1, cursor: null },
      }),
    );
    expect(filtered.page).toHaveLength(1);
    expect(filtered.isDone).toBe(false);
  });

  it("computes summary, spending by category and cashflow for a user", async () => {
    const t = setupTest();
    const accountId = await seedAccount(t, ALICE);
    const categoryId = await seedCategory(t, ALICE, "Food");
    const add = (type: "income" | "expense", amount: number, date: string, cat?: any) =>
      t.run((ctx) =>
        transactions.createTransaction(ctx, ALICE, {
          type,
          amount,
          accountId,
          date,
          ...(cat ? { categoryId: cat } : {}),
        }),
      );
    await add("income", 9000, "2026-03-05");
    await add("expense", 2000, "2026-03-06", categoryId);
    await add("expense", 500, "2026-03-07");
    await add("expense", 700, "2026-02-07");

    const summary = await t.run((ctx) =>
      transactions.getTransactionSummary(ctx, ALICE, { month: "2026-03" }),
    );
    expect(summary).toMatchObject({ totalIncome: 9000, totalExpenses: 2500, totalAdjustments: 0 });
    expect(summary.recentTransactions).toHaveLength(3);

    const spending = await t.run((ctx) =>
      transactions.getSpendingByCategory(ctx, ALICE, { month: "2026-03" }),
    );
    expect(spending.total).toBe(2500);
    expect(spending.categories).toEqual([
      { name: "Food", amount: 2000, categoryId },
      { name: "Uncategorized", amount: 500, categoryId: null },
    ]);

    const cashflow = await t.run((ctx) =>
      transactions.getCashflow(ctx, ALICE, { month: "2026-03", trendMonths: 2 }),
    );
    expect(cashflow.currentMonth).toEqual({ income: 9000, expenses: 2500, net: 6500 });
    expect(cashflow.trend).toEqual([
      { month: "Feb", income: 0, expenses: 700 },
      { month: "Mar", income: 9000, expenses: 2500 },
    ]);

    // Another user sees none of it
    const other = await t.run((ctx) =>
      transactions.getTransactionSummary(ctx, BOB, { month: "2026-03" }),
    );
    expect(other).toMatchObject({ totalIncome: 0, totalExpenses: 0, recentTransactions: [] });
    expect(
      await t.run((ctx) => transactions.listTransactions(ctx, BOB, {})),
    ).toMatchObject({ page: [] });
  });

  describe("amount validation", () => {
    it("rejects zero, negative and non-integer income/expense amounts on create", async () => {
      const t = setupTest();
      const accountId = await seedAccount(t, ALICE);
      for (const type of ["income", "expense"] as const) {
        for (const amount of [0, -100, 10.5, Number.NaN]) {
          await expect(
            t.run((ctx) =>
              transactions.createTransaction(ctx, ALICE, {
                type,
                amount,
                accountId,
                date: "2026-01-01",
              }),
            ),
          ).rejects.toThrow("Amount must be positive");
        }
      }
      expect(await balanceOf(t, accountId)).toBe(10000);
    });

    it("keeps signed amounts for adjustments", async () => {
      const t = setupTest();
      const accountId = await seedAccount(t, ALICE);
      await t.run((ctx) =>
        transactions.createTransaction(ctx, ALICE, {
          type: "adjustment",
          amount: -500,
          accountId,
          date: "2026-01-01",
        }),
      );
      expect(await balanceOf(t, accountId)).toBe(9500);
    });

    it("rejects a non-positive effective amount on update", async () => {
      const t = setupTest();
      const accountId = await seedAccount(t, ALICE);
      const adjId = await t.run((ctx) =>
        transactions.createTransaction(ctx, ALICE, {
          type: "adjustment",
          amount: -500,
          accountId,
          date: "2026-01-01",
        }),
      );
      const expenseId = await t.run((ctx) =>
        transactions.createTransaction(ctx, ALICE, {
          type: "expense",
          amount: 1000,
          accountId,
          date: "2026-01-01",
        }),
      );
      await expect(
        t.run((ctx) => transactions.updateTransaction(ctx, ALICE, { id: expenseId, amount: 0 })),
      ).rejects.toThrow("Amount must be positive");
      await expect(
        t.run((ctx) => transactions.updateTransaction(ctx, ALICE, { id: expenseId, amount: -5 })),
      ).rejects.toThrow("Amount must be positive");
      // Switching a negative adjustment to income without a new amount is invalid.
      await expect(
        t.run((ctx) => transactions.updateTransaction(ctx, ALICE, { id: adjId, type: "income" })),
      ).rejects.toThrow("Amount must be positive");
      expect(await balanceOf(t, accountId)).toBe(8500);
    });
  });

  describe("transfer legs", () => {
    async function seedTransfer(t: T) {
      const from = await seedAccount(t, ALICE, 10000);
      const to = await seedAccount(t, ALICE, 5000);
      const result = await t.run((ctx) =>
        transfers.createTransfer(ctx, ALICE, {
          amount: 2000,
          fromAccountId: from,
          toAccountId: to,
          date: "2026-01-01",
        }),
      );
      return { from, to, result };
    }

    it("refuses plain delete and update on either leg", async () => {
      const t = setupTest();
      const { from, to, result } = await seedTransfer(t);
      const legs = await t.run((ctx) =>
        ctx.db.query("transactions").withIndex("by_accountId", (q) => q.eq("accountId", from)).collect(),
      );
      const incoming = await t.run((ctx) =>
        ctx.db.query("transactions").withIndex("by_accountId", (q) => q.eq("accountId", to)).collect(),
      );
      expect(result).toBeTruthy();
      for (const leg of [...legs, ...incoming]) {
        await expect(
          t.run((ctx) => transactions.deleteTransaction(ctx, ALICE, { id: leg._id })),
        ).rejects.toThrow("Use the transfer delete for transfers");
        await expect(
          t.run((ctx) => transactions.updateTransaction(ctx, ALICE, { id: leg._id, amount: 1 })),
        ).rejects.toThrow("Use the transfer");
      }
      expect(await balanceOf(t, from)).toBe(8000);
      expect(await balanceOf(t, to)).toBe(7000);
    });
  });

  describe("cross-user ownership", () => {
    it("rejects foreign account, category and subcategory references on create", async () => {
      const t = setupTest();
      const aliceAccount = await seedAccount(t, ALICE);
      const bobAccount = await seedAccount(t, BOB);
      const bobCategory = await seedCategory(t, BOB);
      const bobSub = await t.run((ctx) =>
        categories.createSubcategory(ctx, BOB, { categoryId: bobCategory, name: "Sub" }),
      );

      await expect(
        t.run((ctx) =>
          transactions.createTransaction(ctx, ALICE, {
            type: "expense",
            amount: 1,
            accountId: bobAccount,
            date: "2026-03-10",
          }),
        ),
      ).rejects.toThrow("Account not found");
      await expect(
        t.run((ctx) =>
          transactions.createTransaction(ctx, ALICE, {
            type: "expense",
            amount: 1,
            accountId: aliceAccount,
            categoryId: bobCategory,
            date: "2026-03-10",
          }),
        ),
      ).rejects.toThrow("Category not found");
      await expect(
        t.run((ctx) =>
          transactions.createTransaction(ctx, ALICE, {
            type: "expense",
            amount: 1,
            accountId: aliceAccount,
            subcategoryId: bobSub,
            date: "2026-03-10",
          }),
        ),
      ).rejects.toThrow("Subcategory not found");
      expect(await balanceOf(t, aliceAccount)).toBe(10000);
    });

    it("rejects update/delete of another user's transaction and moving it to a foreign account", async () => {
      const t = setupTest();
      const aliceAccount = await seedAccount(t, ALICE);
      const bobAccount = await seedAccount(t, BOB);
      const id = await t.run((ctx) =>
        transactions.createTransaction(ctx, ALICE, {
          type: "expense",
          amount: 100,
          accountId: aliceAccount,
          date: "2026-03-10",
        }),
      );

      await expect(
        t.run((ctx) => transactions.updateTransaction(ctx, BOB, { id, amount: 1 })),
      ).rejects.toThrow("Transaction not found");
      await expect(
        t.run((ctx) => transactions.deleteTransaction(ctx, BOB, { id })),
      ).rejects.toThrow("Transaction not found");
      await expect(
        t.run((ctx) =>
          transactions.updateTransaction(ctx, ALICE, { id, accountId: bobAccount }),
        ),
      ).rejects.toThrow("Account not found");

      expect(await balanceOf(t, aliceAccount)).toBe(9900);
      expect(await balanceOf(t, bobAccount)).toBe(10000);
    });
  });
});
