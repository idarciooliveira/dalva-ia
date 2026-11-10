import { describe, expect, it } from "vitest";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import * as accounts from "./domain/accounts";
import * as savingsGoals from "./domain/savingsGoals";
import { setupTest } from "./test.setup";

const ALICE = "alice-domain";
const BOB = "bob-domain";

type T = ReturnType<typeof setupTest>;

async function seedGoal(
  t: T,
  userId: string,
  overrides: Partial<Parameters<typeof savingsGoals.createGoal>[2]> = {},
) {
  return await t.run((ctx) =>
    savingsGoals.createGoal(ctx, userId, {
      name: "Trip",
      targetAmount: 100000,
      isVirtual: true,
      ...overrides,
    }),
  );
}

describe("domain/savingsGoals", () => {
  it("creates and lists goals for an explicit userId", async () => {
    const t = setupTest();
    await seedGoal(t, ALICE, { name: "Alice goal", icon: "plane", targetDate: "2027-01-01" });
    await seedGoal(t, BOB, { name: "Bob goal" });

    const mine = await t.run((ctx) => savingsGoals.listGoals(ctx, ALICE, {}));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      userId: ALICE,
      name: "Alice goal",
      currentAmount: 0,
      icon: "plane",
      targetDate: "2027-01-01",
      isVirtual: true,
    });
  });

  it("validates target amount on create and update", async () => {
    const t = setupTest();
    await expect(seedGoal(t, ALICE, { targetAmount: 0 })).rejects.toThrow(
      "Target amount must be positive",
    );
    const id = await seedGoal(t, ALICE);
    await expect(
      t.run((ctx) => savingsGoals.updateGoal(ctx, ALICE, { id, targetAmount: -1 })),
    ).rejects.toThrow("Target amount must be positive");
  });

  it("updates, archives, restores and deletes (with contributions)", async () => {
    const t = setupTest();
    const id = await seedGoal(t, ALICE);
    await t.run((ctx) => savingsGoals.updateGoal(ctx, ALICE, { id, name: "Renamed", color: "#000" }));
    expect(await t.run((ctx) => savingsGoals.getGoal(ctx, ALICE, { id }))).toMatchObject({
      name: "Renamed",
      color: "#000",
    });

    await t.run((ctx) => savingsGoals.archiveGoal(ctx, ALICE, { id }));
    expect(await t.run((ctx) => savingsGoals.listGoals(ctx, ALICE, {}))).toEqual([]);
    expect(
      await t.run((ctx) => savingsGoals.listGoals(ctx, ALICE, { includeArchived: true })),
    ).toHaveLength(1);
    await t.run((ctx) => savingsGoals.restoreGoal(ctx, ALICE, { id }));

    const contributionId = await t.run((ctx) =>
      ctx.db.insert("goalContributions", { userId: ALICE, goalId: id, amount: 5, date: "2026-01-01" }),
    );
    await t.run((ctx) => savingsGoals.deleteGoal(ctx, ALICE, { id }));
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(contributionId))).toBeNull();
  });

  describe("cross-user ownership", () => {
    it("rejects every id-based operation from another user", async () => {
      const t = setupTest();
      const id = await seedGoal(t, ALICE);
      const ops: Array<(ctx: MutationCtx) => Promise<unknown>> = [
        (ctx) => savingsGoals.getGoal(ctx, BOB, { id }),
        (ctx) => savingsGoals.updateGoal(ctx, BOB, { id, name: "x" }),
        (ctx) => savingsGoals.archiveGoal(ctx, BOB, { id }),
        (ctx) => savingsGoals.restoreGoal(ctx, BOB, { id }),
        (ctx) => savingsGoals.deleteGoal(ctx, BOB, { id }),
      ];
      for (const op of ops) {
        await expect(t.run(op)).rejects.toThrow("Goal not found");
      }
      expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ userId: ALICE, name: "Trip" });
      expect(await t.run((ctx) => savingsGoals.listGoals(ctx, BOB, {}))).toEqual([]);
    });

    it("rejects linking a goal to another user's account", async () => {
      const t = setupTest();
      const theirs: Id<"accounts"> = await t.run((ctx) =>
        accounts.createAccount(ctx, BOB, { name: "B", type: "bank", balance: 0, currency: "USD" }),
      );
      await expect(
        seedGoal(t, ALICE, { isVirtual: false, linkedAccountId: theirs }),
      ).rejects.toThrow("Account not found");
    });
  });
});
