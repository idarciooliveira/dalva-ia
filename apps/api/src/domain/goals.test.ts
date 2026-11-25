import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { balanceOf, domainRejection, getTransactionRow, seedAccount, seedTransaction, seedUser, transactionRows } from "../../test/api";
import { createTestUser } from "../../test/app";
import { testDb } from "../../test/db";
import { goalContributions, savingsGoals } from "../db/schema";
import { readTx, type Tx, withTx } from "../db/tx";
import * as goals from "./goals";
import * as transfers from "./transfers";

const tx = <T>(fn: (tx: Tx) => Promise<T>) => withTx(testDb(), fn);
const read = <T>(fn: (tx: Tx) => Promise<T>) => readTx(testDb(), fn);

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });
const eur = (amountMinor: number) => ({ amountMinor, currency: "EUR" });
const DAY = "2026-03-01";

const seedGoal = async (userId: string, overrides: Partial<goals.GoalFields> = {}) =>
  (await tx((t) => goals.createGoal(t, userId, { name: "Trip", targetAmount: usd(100_000), isVirtual: true, ...overrides }))).goal;

const contribute = async (userId: string, args: Omit<goals.ContributionFields, "date" | "amount"> & { amount: number; date?: string }) =>
  (await tx((t) => goals.addContribution(t, userId, { date: DAY, ...args, amount: usd(args.amount) }))).contribution;

const seedLinkedGoal = (userId: string, linkedAccountId: string) =>
  seedGoal(userId, { name: "House", isVirtual: false, linkedAccountId });

const goalRow = async (id: string) => (await testDb().select().from(savingsGoals).where(eq(savingsGoals.id, id)))[0];
const contributionRow = async (id: string) => (await testDb().select().from(goalContributions).where(eq(goalContributions.id, id)))[0];

describe("domain/goals", () => {
  it("creates and lists goals for the given user only", async () => {
    const alice = await seedUser();
    const bob = await seedUser();
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
    const alice = await seedUser();
    expect(await domainRejection(seedGoal(alice, { targetAmount: usd(0) }))).toEqual({
      code: "validation_failed",
      message: "Target amount must be positive",
    });
    const { id } = await seedGoal(alice);
    expect(await domainRejection(tx((t) => goals.updateGoal(t, alice, id, { targetAmount: usd(-1) })))).toMatchObject({
      message: "Target amount must be positive",
    });
  });

  it("updates, archives, restores and deletes (with contributions)", async () => {
    const alice = await seedUser();
    const { id } = await seedGoal(alice);
    expect((await tx((t) => goals.updateGoal(t, alice, id, { name: "Renamed", color: "#000" }))).goal).toMatchObject({
      name: "Renamed",
      color: "#000",
      targetAmount: 100_000,
    });

    await tx((t) => goals.setGoalArchived(t, alice, id, true));
    expect(await read((t) => goals.listGoals(t, alice))).toEqual([]);
    expect(await read((t) => goals.listGoals(t, alice, { includeArchived: true }))).toHaveLength(1);
    await tx((t) => goals.setGoalArchived(t, alice, id, false));
    expect(await read((t) => goals.listGoals(t, alice))).toHaveLength(1);

    const contribution = await contribute(alice, { goalId: id, amount: 5 });
    await tx((t) => goals.deleteGoal(t, alice, id));
    expect(await goalRow(id)).toBeUndefined();
    expect(await contributionRow(contribution.id)).toBeUndefined();
  });

  it("deleting a goal keeps its contributions' transfers, which become plain transfers", async () => {
    const alice = await seedUser();
    const from = await seedAccount(alice, { balance: 10_000 });
    const linked = await seedAccount(alice);
    const goal = await seedLinkedGoal(alice, linked);
    const contribution = await contribute(alice, { goalId: goal.id, amount: 3_000, fromAccountId: from });

    await tx((t) => goals.deleteGoal(t, alice, goal.id));
    expect(await transactionRows()).toHaveLength(2);
    expect(await balanceOf(linked)).toBe(3_000);
    await tx((t) => transfers.deleteTransfer(t, alice, contribution.transactionId!));
    expect(await balanceOf(from)).toBe(10_000);
    expect(await balanceOf(linked)).toBe(0);
  });

  it("works in the base currency: amounts and accounts in another one are refused", async () => {
    const alice = await seedUser({ baseCurrency: "EUR" });
    const usdAccount = await seedAccount(alice);
    const eurAccount = await seedAccount(alice, { currency: "EUR", balance: 10_000 });
    expect(await domainRejection(seedGoal(alice))).toEqual({ code: "validation_failed", message: "Currency must be EUR, got USD" });
    expect(await domainRejection(seedGoal(alice, { targetAmount: eur(100), isVirtual: false, linkedAccountId: usdAccount }))).toEqual({
      code: "validation_failed",
      message: "Account currency USD differs from the base currency EUR",
    });
    const goal = await seedGoal(alice, { targetAmount: eur(100), isVirtual: false, linkedAccountId: await seedAccount(alice, { currency: "EUR" }) });
    expect(await domainRejection(tx((t) => goals.updateGoal(t, alice, goal.id, { targetAmount: usd(5) })))).toMatchObject({ code: "validation_failed" });

    const add = (fromAccountId: string, amount = eur(10)) =>
      tx((t) => goals.addContribution(t, alice, { goalId: goal.id, amount, date: DAY, fromAccountId }));
    expect(await domainRejection(add(eurAccount, usd(10)))).toEqual({ code: "validation_failed", message: "Currency must be EUR, got USD" });
    expect(await domainRejection(add(usdAccount))).toEqual({
      code: "validation_failed",
      message: "Account currency USD differs from the goal currency EUR",
    });
    await add(eurAccount);
    expect(await balanceOf(eurAccount)).toBe(9_990);
    expect(await goalRow(goal.id)).toMatchObject({ currentAmount: 10 });
  });

  it("needs a profile for the base currency", async () => {
    const user = await createTestUser();
    expect(await domainRejection(seedGoal(user))).toEqual({ code: "conflict", message: "User profile not found; complete onboarding first" });
  });

  describe("cross-user ownership", () => {
    it("rejects every id-based operation from another user", async () => {
      const alice = await seedUser();
      const bob = await seedUser();
      const { id } = await seedGoal(alice);
      const ops: Array<(t: Tx) => Promise<unknown>> = [
        (t) => goals.getGoal(t, bob, id),
        (t) => goals.updateGoal(t, bob, id, { name: "x" }),
        (t) => goals.setGoalArchived(t, bob, id, true),
        (t) => goals.deleteGoal(t, bob, id),
      ];
      for (const op of ops) {
        expect(await domainRejection(tx(op))).toEqual({ code: "not_found", message: "Goal not found" });
      }
      expect(await goalRow(id)).toMatchObject({ userId: alice, name: "Trip", archived: false });
      expect(await read((t) => goals.listGoals(t, bob))).toEqual([]);
    });

    it("rejects linking a goal to another user's account", async () => {
      const alice = await seedUser();
      const theirs = await seedAccount(await seedUser());
      expect(await domainRejection(seedLinkedGoal(alice, theirs))).toEqual({ code: "not_found", message: "Account not found" });
    });
  });
});

describe("domain/goals contributions", () => {
  it("records a virtual contribution and updates currentAmount", async () => {
    const alice = await seedUser();
    const goal = await seedGoal(alice);
    const contribution = await contribute(alice, { goalId: goal.id, amount: 2_500, note: "n" });
    expect(contribution).toMatchObject({ userId: alice, goalId: goal.id, amount: 2_500, note: "n", transactionId: null });
    await contribute(alice, { goalId: goal.id, amount: 500, date: "2026-03-02" });
    expect(await goalRow(goal.id)).toMatchObject({ currentAmount: 3_000 });
    expect((await read((t) => goals.listContributions(t, alice, goal.id))).map((c) => c.amount)).toEqual([2_500, 500]);
    expect(await transactionRows()).toEqual([]);
  });

  it("validates the amount, and the source account by kind of goal", async () => {
    const alice = await seedUser();
    const goal = await seedGoal(alice);
    const add = (args: Parameters<typeof contribute>[1]) => contribute(alice, args);
    for (const amount of [0, -1]) {
      expect(await domainRejection(add({ goalId: goal.id, amount }))).toEqual({ code: "validation_failed", message: "Amount must be positive" });
    }
    expect(await domainRejection(add({ goalId: goal.id, amount: 1.5 }))).toMatchObject({ code: "validation_failed" });
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
    const alice = await seedUser();
    const from = await seedAccount(alice, { balance: 10_000 });
    const linked = await seedAccount(alice);
    const goal = await seedLinkedGoal(alice, linked);

    const contribution = await contribute(alice, { goalId: goal.id, amount: 3_000, fromAccountId: from, note: "June" });
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

  it("refuses a contribution that would take the goal total out of the money range, writing nothing", async () => {
    const alice = await seedUser();
    const from = await seedAccount(alice, { balance: 10_000 });
    const goal = await seedLinkedGoal(alice, await seedAccount(alice));
    const nearMax = Number.MAX_SAFE_INTEGER - 50;
    await testDb().update(savingsGoals).set({ currentAmount: nearMax }).where(eq(savingsGoals.id, goal.id));
    expect(await domainRejection(contribute(alice, { goalId: goal.id, amount: 100, fromAccountId: from }))).toEqual({
      code: "validation_failed",
      message: "Goal total out of range",
    });
    expect(await goalRow(goal.id)).toMatchObject({ currentAmount: nearMax });
    expect(await transactionRows()).toEqual([]);
    expect(await balanceOf(from)).toBe(10_000);
  });

  it("removal never takes currentAmount below zero", async () => {
    const alice = await seedUser();
    const goal = await seedGoal(alice);
    const contribution = await contribute(alice, { goalId: goal.id, amount: 1_000 });
    await testDb().update(savingsGoals).set({ currentAmount: 400 }).where(eq(savingsGoals.id, goal.id));
    await tx((t) => goals.removeContribution(t, alice, contribution.id));
    expect(await goalRow(goal.id)).toMatchObject({ currentAmount: 0 });
  });

  describe("legacy rows", () => {
    it("removes a contribution whose transfer is gone (transaction_id nulled): only currentAmount moves", async () => {
      const alice = await seedUser();
      const from = await seedAccount(alice, { balance: 10_000 });
      const linked = await seedAccount(alice);
      const goal = await seedLinkedGoal(alice, linked);
      const contribution = await contribute(alice, { goalId: goal.id, amount: 3_000, fromAccountId: from });
      await testDb().update(goalContributions).set({ transactionId: null }).where(eq(goalContributions.id, contribution.id));

      await tx((t) => goals.removeContribution(t, alice, contribution.id));
      expect(await goalRow(goal.id)).toMatchObject({ currentAmount: 0 });
      expect(await balanceOf(from)).toBe(7_000);
      expect(await transactionRows()).toHaveLength(2);
    });

    it("removes a contribution pointing at a non-transfer row, keeping that row and its balance", async () => {
      const alice = await seedUser();
      const accountId = await seedAccount(alice, { balance: 10_000 });
      const goal = await seedGoal(alice);
      const spent = await seedTransaction(alice, accountId, { type: "expense", amount: 700 });
      const [contribution] = await testDb()
        .insert(goalContributions)
        .values({ userId: alice, goalId: goal.id, amount: 700, date: "2026-03-01", transactionId: spent })
        .returning();
      await testDb().update(savingsGoals).set({ currentAmount: 700 }).where(eq(savingsGoals.id, goal.id));

      await tx((t) => goals.removeContribution(t, alice, contribution!.id));
      expect(await getTransactionRow(spent)).toMatchObject({ amount: 700 });
      expect(await balanceOf(accountId)).toBe(10_000);
      expect(await goalRow(goal.id)).toMatchObject({ currentAmount: 0 });
    });

    it("removes the remaining leg of a contribution transfer whose pair is gone", async () => {
      const alice = await seedUser();
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
      const alice = await seedUser();
      const bob = await seedUser();
      const goal = await seedGoal(alice);
      const contribution = await contribute(alice, { goalId: goal.id, amount: 100 });

      expect(await domainRejection(read((t) => goals.listContributions(t, bob, goal.id)))).toMatchObject({ message: "Goal not found" });
      expect(await domainRejection(contribute(bob, { goalId: goal.id, amount: 1 }))).toMatchObject({
        message: "Goal not found",
      });
      expect(await domainRejection(tx((t) => goals.removeContribution(t, bob, contribution.id)))).toEqual({
        code: "not_found",
        message: "Contribution not found",
      });
      expect(await goalRow(goal.id)).toMatchObject({ currentAmount: 100 });
    });

    it("rejects a foreign source account for linked goals", async () => {
      const alice = await seedUser();
      const linked = await seedAccount(alice);
      const goal = await seedLinkedGoal(alice, linked);
      const theirs = await seedAccount(await seedUser(), { balance: 10_000 });
      expect(await domainRejection(contribute(alice, { goalId: goal.id, amount: 10, fromAccountId: theirs }))).toEqual({
        code: "not_found",
        message: "Account not found",
      });
      expect(await balanceOf(theirs)).toBe(10_000);
    });
  });
});
