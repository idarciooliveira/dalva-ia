import { describe, expect, it } from "vitest";
import type { Id } from "./_generated/dataModel";
import * as accounts from "./domain/accounts";
import * as goalContributions from "./domain/goalContributions";
import * as savingsGoals from "./domain/savingsGoals";
import { setupTest } from "./test.setup";

const ALICE = "alice-domain";
const BOB = "bob-domain";

type T = ReturnType<typeof setupTest>;

async function seedAccount(t: T, userId: string, balance = 10000) {
  return await t.run((ctx) =>
    accounts.createAccount(ctx, userId, { name: "Acct", type: "bank", balance, currency: "USD" }),
  );
}

async function balanceOf(t: T, id: Id<"accounts">) {
  return (await t.run((ctx) => ctx.db.get(id)))?.balance;
}

async function seedVirtualGoal(t: T, userId: string) {
  return await t.run((ctx) =>
    savingsGoals.createGoal(ctx, userId, { name: "Trip", targetAmount: 100000, isVirtual: true }),
  );
}

async function seedLinkedGoal(t: T, userId: string, linkedAccountId: Id<"accounts">) {
  return await t.run((ctx) =>
    savingsGoals.createGoal(ctx, userId, {
      name: "House",
      targetAmount: 100000,
      isVirtual: false,
      linkedAccountId,
    }),
  );
}

describe("domain/goalContributions", () => {
  it("records a virtual contribution and updates currentAmount", async () => {
    const t = setupTest();
    const goalId = await seedVirtualGoal(t, ALICE);
    const id = await t.run((ctx) =>
      goalContributions.addContribution(ctx, ALICE, { goalId, amount: 2500, date: "2026-03-01", note: "n" }),
    );
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      userId: ALICE,
      goalId,
      amount: 2500,
      note: "n",
    });
    expect(await t.run((ctx) => ctx.db.get(goalId))).toMatchObject({ currentAmount: 2500 });
    expect(
      await t.run((ctx) => goalContributions.listContributions(ctx, ALICE, { goalId })),
    ).toHaveLength(1);
  });

  it("validates amount, and source account for linked goals", async () => {
    const t = setupTest();
    const goalId = await seedVirtualGoal(t, ALICE);
    await expect(
      t.run((ctx) => goalContributions.addContribution(ctx, ALICE, { goalId, amount: 0, date: "2026-03-01" })),
    ).rejects.toThrow("Amount must be positive");

    const linked = await seedAccount(t, ALICE);
    const linkedGoal = await seedLinkedGoal(t, ALICE, linked);
    await expect(
      t.run((ctx) =>
        goalContributions.addContribution(ctx, ALICE, { goalId: linkedGoal, amount: 10, date: "2026-03-01" }),
      ),
    ).rejects.toThrow("Source account is required for account-linked goal contributions");
    await expect(
      t.run((ctx) =>
        goalContributions.addContribution(ctx, ALICE, {
          goalId: linkedGoal, amount: 10, date: "2026-03-01", fromAccountId: linked,
        }),
      ),
    ).rejects.toThrow("Cannot transfer to the same account");
  });

  it("linked contribution creates a paired transfer, and removal reverses it", async () => {
    const t = setupTest();
    const from = await seedAccount(t, ALICE, 10000);
    const linked = await seedAccount(t, ALICE, 0);
    const goalId = await seedLinkedGoal(t, ALICE, linked);

    const id = await t.run((ctx) =>
      goalContributions.addContribution(ctx, ALICE, {
        goalId, amount: 3000, date: "2026-03-01", fromAccountId: from,
      }),
    );
    expect(await balanceOf(t, from)).toBe(7000);
    expect(await balanceOf(t, linked)).toBe(3000);
    const txs = await t.run((ctx) => ctx.db.query("transactions").collect());
    expect(txs).toHaveLength(2);
    expect(txs.every((x) => x.type === "transfer" && x.description === "Savings: House")).toBe(true);
    expect(txs[0]!.transferGroupId).toBe(txs[1]!.transferGroupId);
    const contribution = await t.run((ctx) => ctx.db.get(id));
    expect(contribution?.transactionId).toBeDefined();

    await t.run((ctx) => goalContributions.removeContribution(ctx, ALICE, { id }));
    expect(await balanceOf(t, from)).toBe(10000);
    expect(await balanceOf(t, linked)).toBe(0);
    expect(await t.run((ctx) => ctx.db.query("transactions").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(goalId))).toMatchObject({ currentAmount: 0 });
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
  });

  describe("cross-user ownership", () => {
    it("rejects list/add/remove against another user's goal or contribution", async () => {
      const t = setupTest();
      const goalId = await seedVirtualGoal(t, ALICE);
      const id = await t.run((ctx) =>
        goalContributions.addContribution(ctx, ALICE, { goalId, amount: 100, date: "2026-03-01" }),
      );

      await expect(
        t.run((ctx) => goalContributions.listContributions(ctx, BOB, { goalId })),
      ).rejects.toThrow("Goal not found");
      await expect(
        t.run((ctx) => goalContributions.addContribution(ctx, BOB, { goalId, amount: 1, date: "2026-03-01" })),
      ).rejects.toThrow("Goal not found");
      await expect(
        t.run((ctx) => goalContributions.removeContribution(ctx, BOB, { id })),
      ).rejects.toThrow("Contribution not found");
      expect(await t.run((ctx) => ctx.db.get(goalId))).toMatchObject({ currentAmount: 100 });
    });

    it("rejects a foreign source account for linked goals", async () => {
      const t = setupTest();
      const linked = await seedAccount(t, ALICE);
      const goalId = await seedLinkedGoal(t, ALICE, linked);
      const theirs = await seedAccount(t, BOB);
      await expect(
        t.run((ctx) =>
          goalContributions.addContribution(ctx, ALICE, {
            goalId, amount: 10, date: "2026-03-01", fromAccountId: theirs,
          }),
        ),
      ).rejects.toThrow("Account not found");
      expect(await balanceOf(t, theirs)).toBe(10000);
    });
  });
});
