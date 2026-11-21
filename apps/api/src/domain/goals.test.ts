import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { balanceOf, domainRejection, getTransactionRow, seedAccount, seedTransaction, transactionRows } from "../../test/api";
import { createTestUser } from "../../test/app";
import { testDb } from "../../test/db";
import { goalContributions, savingsGoals } from "../db/schema";
import { readTx, type Tx, withTx } from "../db/tx";
import * as goals from "./goals";
import * as transfers from "./transfers";

const tx = <T>(fn: (tx: Tx) => Promise<T>) => withTx(testDb(), fn);
const read = <T>(fn: (tx: Tx) => Promise<T>) => readTx(testDb(), fn);

const seedGoal = (userId: string, overrides: Partial<goals.GoalFields> = {}) =>
  tx((t) => goals.createGoal(t, userId, { name: "Trip", targetAmount: 100_000, isVirtual: true, ...overrides }));

const seedLinkedGoal = (userId: string, linkedAccountId: string) =>
  seedGoal(userId, { name: "House", isVirtual: false, linkedAccountId });

const goalRow = async (id: string) => (await testDb().select().from(savingsGoals).where(eq(savingsGoals.id, id)))[0];
const contributionRow = async (id: string) => (await testDb().select().from(goalContributions).where(eq(goalContributions.id, id)))[0];

describe("domain/goals", () => {
  it("creates and lists goals for the given user only", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    await seedGoal(alice, { name: "Alice goal", icon: "plane", targetDate: "2027-01-01" });
    await seedGoal(bob, { name: "Bob goal" });

    const mine = await read((t) => goals.listGoals(t, alice));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      userId: alice,
      name: "Alice goal",
      currentAmount: 0,
      icon: "plane",
      targetDate: "2027-01-01",
      isVirtual: true,
      archived: false,
    });
    expect(mine[0]!.createdOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("validates the target amount on create and update", async () => {
    const alice = await createTestUser();
    expect(await domainRejection(seedGoal(alice, { targetAmount: 0 }))).toEqual({
      code: "validation_failed",
      message: "Target amount must be positive",
    });
    const { id } = await seedGoal(alice);
    expect(await domainRejection(tx((t) => goals.updateGoal(t, alice, id, { targetAmount: -1 })))).toMatchObject({
      message: "Target amount must be positive",
    });
  });

  it("updates, archives, restores and deletes (with contributions)", async () => {
    const alice = await createTestUser();
    const { id } = await seedGoal(alice);
    expect(await tx((t) => goals.updateGoal(t, alice, id, { name: "Renamed", color: "#000" }))).toMatchObject({
      name: "Renamed",
      color: "#000",
      targetAmount: 100_000,
    });

    await tx((t) => goals.updateGoal(t, alice, id, { archived: true }));
    expect(await read((t) => goals.listGoals(t, alice))).toEqual([]);
    expect(await read((t) => goals.listGoals(t, alice, { includeArchived: true }))).toHaveLength(1);
    await tx((t) => goals.updateGoal(t, alice, id, { archived: false }));
    expect(await read((t) => goals.listGoals(t, alice))).toHaveLength(1);

    const contribution = await tx((t) => goals.addContribution(t, alice, { goalId: id, amount: 5, date: "2026-01-01" }));
    await tx((t) => goals.deleteGoal(t, alice, id));
    expect(await goalRow(id)).toBeUndefined();
    expect(await contributionRow(contribution.id)).toBeUndefined();
  });

  it("deleting a goal keeps its contributions' transfers, which become plain transfers", async () => {
    const alice = await createTestUser();
    const from = await seedAccount(alice, { balance: 10_000 });
    const linked = await seedAccount(alice);
    const goal = await seedLinkedGoal(alice, linked);
    const contribution = await tx((t) => goals.addContribution(t, alice, { goalId: goal.id, amount: 3_000, date: "2026-03-01", fromAccountId: from }));

    await tx((t) => goals.deleteGoal(t, alice, goal.id));
    expect(await transactionRows()).toHaveLength(2);
    expect(await balanceOf(linked)).toBe(3_000);
    await tx((t) => transfers.deleteTransfer(t, alice, contribution.transactionId!));
    expect(await balanceOf(from)).toBe(10_000);
    expect(await balanceOf(linked)).toBe(0);
  });

  describe("cross-user ownership", () => {
    it("rejects every id-based operation from another user", async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const { id } = await seedGoal(alice);
      const ops: Array<(t: Tx) => Promise<unknown>> = [
        (t) => goals.getGoal(t, bob, id),
        (t) => goals.updateGoal(t, bob, id, { name: "x" }),
        (t) => goals.updateGoal(t, bob, id, { archived: true }),
        (t) => goals.deleteGoal(t, bob, id),
      ];
      for (const op of ops) {
        expect(await domainRejection(tx(op))).toEqual({ code: "not_found", message: "Goal not found" });
      }
      expect(await goalRow(id)).toMatchObject({ userId: alice, name: "Trip", archived: false });
      expect(await read((t) => goals.listGoals(t, bob))).toEqual([]);
    });

    it("rejects linking a goal to another user's account", async () => {
      const alice = await createTestUser();
      const theirs = await seedAccount(await createTestUser());
      expect(await domainRejection(seedLinkedGoal(alice, theirs))).toEqual({ code: "not_found", message: "Account not found" });
    });
  });
});

describe("domain/goals contributions", () => {
  it("records a virtual contribution and updates currentAmount", async () => {
    const alice = await createTestUser();
    const goal = await seedGoal(alice);
    const contribution = await tx((t) => goals.addContribution(t, alice, { goalId: goal.id, amount: 2_500, date: "2026-03-01", note: "n" }));
    expect(contribution).toMatchObject({ userId: alice, goalId: goal.id, amount: 2_500, note: "n", transactionId: null });
    await tx((t) => goals.addContribution(t, alice, { goalId: goal.id, amount: 500, date: "2026-03-02" }));
    expect(await goalRow(goal.id)).toMatchObject({ currentAmount: 3_000 });
    expect((await read((t) => goals.listContributions(t, alice, goal.id))).map((c) => c.amount)).toEqual([2_500, 500]);
    expect(await transactionRows()).toEqual([]);
  });

  it("validates the amount, and the source account by kind of goal", async () => {
    const alice = await createTestUser();
    const goal = await seedGoal(alice);
    const add = (args: Omit<goals.ContributionFields, "date">) => tx((t) => goals.addContribution(t, alice, { date: "2026-03-01", ...args }));
    for (const amount of [0, -1, 1.5]) {
      expect(await domainRejection(add({ goalId: goal.id, amount }))).toEqual({ code: "validation_failed", message: "Amount must be positive" });
    }
    const linked = await seedAccount(alice);
    expect(await domainRejection(add({ goalId: goal.id, amount: 10, fromAccountId: linked }))).toMatchObject({
      message: "fromAccountId only applies to account-linked goals",
    });

    const linkedGoal = await seedLinkedGoal(alice, linked);
    expect(await domainRejection(add({ goalId: linkedGoal.id, amount: 10 }))).toMatchObject({
      message: "Source account is required for account-linked goal contributions",
    });
    expect(await domainRejection(add({ goalId: linkedGoal.id, amount: 10, fromAccountId: linked }))).toMatchObject({
      message: "Cannot transfer to the same account",
    });
    expect(await goalRow(linkedGoal.id)).toMatchObject({ currentAmount: 0 });
  });

  it("a linked contribution creates a paired transfer, and removal reverses it", async () => {
    const alice = await createTestUser();
    const from = await seedAccount(alice, { balance: 10_000 });
    const linked = await seedAccount(alice);
    const goal = await seedLinkedGoal(alice, linked);

    const contribution = await tx((t) =>
      goals.addContribution(t, alice, { goalId: goal.id, amount: 3_000, date: "2026-03-01", fromAccountId: from, note: "June" }),
    );
    expect(await balanceOf(from)).toBe(7_000);
    expect(await balanceOf(linked)).toBe(3_000);
    const rows = await transactionRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.type === "transfer" && r.description === "Savings: House" && r.note === "June")).toBe(true);
    expect(rows[0]!.transferGroupId).toBe(rows[1]!.transferGroupId);
    expect(await getTransactionRow(contribution.transactionId!)).toMatchObject({ accountId: from, destinationAccountId: linked });

    // The transfer belongs to the contribution.
    expect(await domainRejection(tx((t) => transfers.deleteTransfer(t, alice, contribution.transactionId!)))).toMatchObject({ code: "conflict" });

    await tx((t) => goals.removeContribution(t, alice, contribution.id));
    expect(await balanceOf(from)).toBe(10_000);
    expect(await balanceOf(linked)).toBe(0);
    expect(await transactionRows()).toEqual([]);
    expect(await goalRow(goal.id)).toMatchObject({ currentAmount: 0 });
    expect(await contributionRow(contribution.id)).toBeUndefined();
  });

  it("removal never takes currentAmount below zero", async () => {
    const alice = await createTestUser();
    const goal = await seedGoal(alice);
    const contribution = await tx((t) => goals.addContribution(t, alice, { goalId: goal.id, amount: 1_000, date: "2026-03-01" }));
    await testDb().update(savingsGoals).set({ currentAmount: 400 }).where(eq(savingsGoals.id, goal.id));
    await tx((t) => goals.removeContribution(t, alice, contribution.id));
    expect(await goalRow(goal.id)).toMatchObject({ currentAmount: 0 });
  });

  describe("legacy rows", () => {
    it("removes a contribution whose transfer is gone (transaction_id nulled): only currentAmount moves", async () => {
      const alice = await createTestUser();
      const from = await seedAccount(alice, { balance: 10_000 });
      const linked = await seedAccount(alice);
      const goal = await seedLinkedGoal(alice, linked);
      const contribution = await tx((t) => goals.addContribution(t, alice, { goalId: goal.id, amount: 3_000, date: "2026-03-01", fromAccountId: from }));
      await testDb().update(goalContributions).set({ transactionId: null }).where(eq(goalContributions.id, contribution.id));

      await tx((t) => goals.removeContribution(t, alice, contribution.id));
      expect(await goalRow(goal.id)).toMatchObject({ currentAmount: 0 });
      expect(await balanceOf(from)).toBe(7_000);
      expect(await transactionRows()).toHaveLength(2);
    });

    it("removes the remaining leg of a contribution transfer whose pair is gone", async () => {
      const alice = await createTestUser();
      const from = await seedAccount(alice, { balance: 7_000 });
      const linked = await seedAccount(alice);
      const goal = await seedLinkedGoal(alice, linked);
      // The outgoing leg alone: its incoming leg was deleted in Convex.
      const outgoing = await seedTransaction(alice, from, { type: "transfer", amount: 3_000, destinationAccountId: linked, transferGroupId: randomUUID() });
      const [contribution] = await testDb()
        .insert(goalContributions)
        .values({ userId: alice, goalId: goal.id, amount: 3_000, date: "2026-03-01", transactionId: outgoing })
        .returning();
      await testDb().update(savingsGoals).set({ currentAmount: 3_000 }).where(eq(savingsGoals.id, goal.id));

      await tx((t) => goals.removeContribution(t, alice, contribution!.id));
      expect(await balanceOf(from)).toBe(10_000);
      expect(await balanceOf(linked)).toBe(0);
      expect(await transactionRows()).toEqual([]);
      expect(await goalRow(goal.id)).toMatchObject({ currentAmount: 0 });
    });
  });

  describe("cross-user ownership", () => {
    it("rejects list/add/remove against another user's goal or contribution", async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const goal = await seedGoal(alice);
      const contribution = await tx((t) => goals.addContribution(t, alice, { goalId: goal.id, amount: 100, date: "2026-03-01" }));

      expect(await domainRejection(read((t) => goals.listContributions(t, bob, goal.id)))).toMatchObject({ message: "Goal not found" });
      expect(await domainRejection(tx((t) => goals.addContribution(t, bob, { goalId: goal.id, amount: 1, date: "2026-03-01" })))).toMatchObject({
        message: "Goal not found",
      });
      expect(await domainRejection(tx((t) => goals.removeContribution(t, bob, contribution.id)))).toEqual({
        code: "not_found",
        message: "Contribution not found",
      });
      expect(await goalRow(goal.id)).toMatchObject({ currentAmount: 100 });
    });

    it("rejects a foreign source account for linked goals", async () => {
      const alice = await createTestUser();
      const linked = await seedAccount(alice);
      const goal = await seedLinkedGoal(alice, linked);
      const theirs = await seedAccount(await createTestUser(), { balance: 10_000 });
      expect(
        await domainRejection(tx((t) => goals.addContribution(t, alice, { goalId: goal.id, amount: 10, date: "2026-03-01", fromAccountId: theirs }))),
      ).toEqual({ code: "not_found", message: "Account not found" });
      expect(await balanceOf(theirs)).toBe(10_000);
    });
  });
});
