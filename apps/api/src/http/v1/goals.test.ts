import { routes } from "@mpf/finance-contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  balanceOf,
  clientFor,
  expectApiError,
  expectConforms,
  linkedChat,
  raw,
  seedAccount,
  seedUser,
  tokenFor,
  transactionRows,
  twoUsers,
} from "../../../test/api";
import { testApp } from "../../../test/app";
import { testDb } from "../../../test/db";
import { savingsGoals } from "../../db/schema";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

async function seedGoal(userId: string, extra: { linkedAccountId?: string; archived?: boolean; name?: string } = {}) {
  const [row] = await testDb()
    .insert(savingsGoals)
    .values({
      userId,
      name: extra.name ?? "Trip",
      targetAmount: 100_000,
      isVirtual: !extra.linkedAccountId,
      linkedAccountId: extra.linkedAccountId ?? null,
      archived: extra.archived ?? false,
      createdOn: "2026-01-01",
    })
    .returning({ id: savingsGoals.id });
  return row!.id;
}

const goalRow = async (id: string) => (await testDb().select().from(savingsGoals).where(eq(savingsGoals.id, id)))[0];

describe("api/v1 goals and contributions", () => {
  it("lists and gets goals in the base currency", async () => {
    const { app } = testApp();
    const user = await seedUser({ baseCurrency: "KWD" });
    const goal = await seedGoal(user);
    await seedGoal(user, { archived: true, name: "Old" });
    const token = await tokenFor(user);
    const list = expectConforms(routes.goals.list, await raw(app, "GET", "/goals", { token })) as { items: unknown[] };
    expect(list.items).toEqual([
      {
        id: goal,
        name: "Trip",
        targetAmount: { amountMinor: 1_000_000, currency: "KWD" },
        currentAmount: { amountMinor: 0, currency: "KWD" },
        isVirtual: true,
        createdAt: "2026-01-01",
      },
    ]);
    const client = clientFor(app, token);
    expect((await client.goals.list({ includeArchived: true })).items).toHaveLength(2);
    expect((await client.goals.get({ id: goal })).goal.id).toBe(goal);
  });

  it("adds and removes a virtual contribution", async () => {
    const { alice, asAlice } = await twoUsers();
    const goal = await seedGoal(alice);
    const { contribution } = await asAlice.goalContributions.add({ goalId: goal, amount: usd(2_500), date: "2026-02-01", note: "Bonus" });
    expect(contribution).toEqual({ id: expect.any(String), goalId: goal, amount: usd(2_500), date: "2026-02-01", note: "Bonus" });
    expect((await goalRow(goal))?.currentAmount).toBe(2_500);
    expect((await asAlice.goalContributions.list({ goalId: goal })).items).toEqual([contribution]);
    expect(await asAlice.goalContributions.remove({ id: contribution.id })).toEqual({ id: contribution.id });
    expect((await goalRow(goal))?.currentAmount).toBe(0);
  });

  it("adds a linked contribution as a transfer and validates its accounts", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const savings = await seedAccount(alice, { name: "Savings" });
    const goal = await seedGoal(alice, { linkedAccountId: savings });

    await expectApiError(asAlice.goalContributions.add({ goalId: goal, amount: usd(100), date: "2026-01-01" }), "validation_failed");
    const eur = await seedAccount(alice, { currency: "EUR" });
    await expectApiError(asAlice.goalContributions.add({ goalId: goal, amount: usd(100), date: "2026-01-01", fromAccountId: eur }), "validation_failed");
    await expectApiError(asAlice.goalContributions.add({ goalId: goal, amount: usd(100), date: "2026-01-01", fromAccountId: savings }), "validation_failed");
    await expectApiError(
      asAlice.goalContributions.add({ goalId: goal, amount: { amountMinor: 100, currency: "EUR" }, date: "2026-01-01", fromAccountId: aliceAccount }),
      "validation_failed",
    );

    const { contribution } = await asAlice.goalContributions.add({ goalId: goal, amount: usd(1_000), date: "2026-01-01", fromAccountId: aliceAccount });
    expect(contribution.transactionId).toEqual(expect.any(String));
    expect(await balanceOf(savings)).toBe(1_000);
    expect((await asAlice.transactions.get({ id: contribution.transactionId! })).managedBy).toBe("goal_contribution");
    await expectApiError(asAlice.transfers.delete({ id: contribution.transactionId! }), "conflict", 409);

    await asAlice.goalContributions.remove({ id: contribution.id });
    expect(await balanceOf(aliceAccount)).toBe(100_000);
    expect(await balanceOf(savings)).toBe(0);
  });

  it("rejects fromAccountId on virtual goals and needs a profile for the base currency", async () => {
    const { app, alice, aliceAccount, asAlice } = await twoUsers();
    const goal = await seedGoal(alice);
    await expectApiError(asAlice.goalContributions.add({ goalId: goal, amount: usd(1), date: "2026-01-01", fromAccountId: aliceAccount }), "validation_failed");
    const noProfile = await seedUser({ profile: false });
    await expectApiError(clientFor(app, await tokenFor(noProfile)).goals.list(), "conflict", 409);
  });

  it("isolates users", async () => {
    const { alice, asAlice, asBob } = await twoUsers();
    const goal = await seedGoal(alice);
    const { contribution } = await asAlice.goalContributions.add({ goalId: goal, amount: usd(100), date: "2026-01-01" });
    await expectApiError(asBob.goals.get({ id: goal }), "not_found", 404);
    await expectApiError(asBob.goalContributions.list({ goalId: goal }), "not_found");
    await expectApiError(asBob.goalContributions.add({ goalId: goal, amount: usd(1), date: "2026-01-01" }), "not_found");
    await expectApiError(asBob.goalContributions.remove({ id: contribution.id }), "not_found");
    expect((await asBob.goals.list()).items).toEqual([]);
    expect((await goalRow(goal))?.currentAmount).toBe(100);
  });

  it("answers validation_failed for ids that can't be rows", async () => {
    const { asAlice } = await twoUsers();
    await expectApiError(asAlice.goals.get({ id: "not-a-uuid" }), "validation_failed", 400);
    await expectApiError(asAlice.goalContributions.remove({ id: "nope" }), "validation_failed", 400);
  });

  it("creates, updates, archives, restores and deletes goals (web only)", async () => {
    const { app, alice, aliceAccount, asAlice } = await twoUsers();
    const created = await raw(app, "POST", "/goals", {
      token: await tokenFor(alice),
      idempotencyKey: "goal-create-01",
      body: { name: "Trip", targetAmount: usd(50_000), isVirtual: true, targetDate: "2027-01-01", color: "#a3e635" },
    });
    const { goal } = expectConforms(routes.goals.create, created) as { goal: { id: string } };
    expect(goal).toEqual({
      id: expect.any(String),
      name: "Trip",
      targetAmount: usd(50_000),
      currentAmount: usd(0),
      targetDate: "2027-01-01",
      isVirtual: true,
      color: "#a3e635",
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });

    const updated = await asAlice.goals.update({ id: goal.id, name: "Big trip", targetAmount: usd(60_000) });
    expect(updated.goal).toMatchObject({ name: "Big trip", targetAmount: usd(60_000), targetDate: "2027-01-01" });
    expect((await asAlice.goals.archive({ id: goal.id })).goal.archived).toBe(true);
    expect((await asAlice.goals.list()).items).toEqual([]);
    expect((await asAlice.goals.restore({ id: goal.id })).goal.archived).toBeUndefined();

    const linked = await asAlice.goals.create({ name: "House", targetAmount: usd(1_000), isVirtual: false, linkedAccountId: aliceAccount });
    expect(linked.goal).toMatchObject({ isVirtual: false, linkedAccountId: aliceAccount });

    await asAlice.goalContributions.add({ goalId: goal.id, amount: usd(100), date: "2026-01-01" });
    expect(await asAlice.goals.delete({ id: goal.id })).toEqual({ id: goal.id });
    await expectApiError(asAlice.goals.get({ id: goal.id }), "not_found", 404);
  });

  it("deleting a linked goal leaves its transfers as plain, editable transfers", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const savings = await seedAccount(alice, { name: "Savings" });
    const goal = await seedGoal(alice, { linkedAccountId: savings });
    const { contribution } = await asAlice.goalContributions.add({ goalId: goal, amount: usd(1_000), date: "2026-01-01", fromAccountId: aliceAccount });
    await asAlice.goals.delete({ id: goal });
    expect(await balanceOf(savings)).toBe(1_000);
    await asAlice.transfers.delete({ id: contribution.transactionId! });
    expect(await balanceOf(aliceAccount)).toBe(100_000);
    expect(await transactionRows()).toEqual([]);
  });

  it("validates goal management input", async () => {
    const { alice, bobAccount, asAlice } = await twoUsers();
    const eur = await seedAccount(alice, { currency: "EUR" });
    await expectApiError(asAlice.goals.create({ name: "x", targetAmount: { amountMinor: 1, currency: "EUR" }, isVirtual: true }), "validation_failed");
    await expectApiError(asAlice.goals.create({ name: "x", targetAmount: usd(1), isVirtual: false, linkedAccountId: eur }), "validation_failed");
    await expectApiError(asAlice.goals.create({ name: "x", targetAmount: usd(1), isVirtual: false, linkedAccountId: bobAccount }), "not_found");
    await expectApiError(asAlice.goals.create({ name: "x", targetAmount: usd(1), isVirtual: true, linkedAccountId: eur }), "validation_failed");
    const goal = await seedGoal(alice);
    await expectApiError(asAlice.goals.update({ id: goal, targetAmount: { amountMinor: 1, currency: "EUR" } }), "validation_failed");
    expect((await goalRow(goal))?.targetAmount).toBe(100_000);
  });

  it("keeps goal management away from chat tokens and other users", async () => {
    const { app } = testApp();
    const chat = await linkedChat(app);
    const goal = await seedGoal(chat.userId);
    await expectApiError(chat.finance.goals.create({ name: "x", targetAmount: usd(1), isVirtual: true }), "forbidden", 403);
    await expectApiError(chat.finance.goals.delete({ id: goal }), "forbidden", 403);
    expect((await chat.finance.goals.list()).items).toHaveLength(1);
    const { asBob } = await twoUsers(app);
    await expectApiError(asBob.goals.update({ id: goal, name: "x" }), "not_found", 404);
    await expectApiError(asBob.goals.archive({ id: goal }), "not_found");
    await expectApiError(asBob.goals.restore({ id: goal }), "not_found");
    await expectApiError(asBob.goals.delete({ id: goal }), "not_found");
    expect(await goalRow(goal)).toMatchObject({ name: "Trip", archived: false });
  });

  it("refuses a contribution that would take the goal total out of the money range", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const savings = await seedAccount(alice, { name: "Savings" });
    const goal = await seedGoal(alice, { linkedAccountId: savings });
    const nearMax = Number.MAX_SAFE_INTEGER - 50;
    await testDb().update(savingsGoals).set({ currentAmount: nearMax }).where(eq(savingsGoals.id, goal));

    await expectApiError(
      asAlice.goalContributions.add({ goalId: goal, amount: usd(100), date: "2026-01-01", fromAccountId: aliceAccount }),
      "validation_failed",
      400,
    );
    expect((await goalRow(goal))?.currentAmount).toBe(nearMax);
    expect(await transactionRows()).toEqual([]);
    expect(await balanceOf(aliceAccount)).toBe(100_000);
    expect((await asAlice.goals.get({ id: goal })).goal.currentAmount).toEqual(usd(nearMax));
  });

  it("keeps balances and the goal exact under parallel contributions and removals", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const savings = await seedAccount(alice, { name: "Savings" });
    const linked = await seedGoal(alice, { linkedAccountId: savings });
    const virtual = await seedGoal(alice, { name: "Virtual" });

    const added = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        i % 3 === 0
          ? asAlice.goalContributions.add({ goalId: virtual, amount: usd(100 + i), date: "2026-01-01" })
          : asAlice.goalContributions.add({ goalId: linked, amount: usd(1_000 + i), date: "2026-01-01", fromAccountId: aliceAccount }),
      ),
    );
    const linkedTotal = added.filter((_, i) => i % 3 !== 0).reduce((sum, { contribution }) => sum + contribution.amount.amountMinor, 0);
    const virtualTotal = added.filter((_, i) => i % 3 === 0).reduce((sum, { contribution }) => sum + contribution.amount.amountMinor, 0);
    expect(await balanceOf(aliceAccount)).toBe(100_000 - linkedTotal);
    expect(await balanceOf(savings)).toBe(linkedTotal);
    expect((await goalRow(linked))?.currentAmount).toBe(linkedTotal);
    expect((await goalRow(virtual))?.currentAmount).toBe(virtualTotal);

    await Promise.all(added.map(({ contribution }) => asAlice.goalContributions.remove({ id: contribution.id })));
    expect(await balanceOf(aliceAccount)).toBe(100_000);
    expect(await balanceOf(savings)).toBe(0);
    expect((await goalRow(linked))?.currentAmount).toBe(0);
    expect((await goalRow(virtual))?.currentAmount).toBe(0);
    expect(await transactionRows()).toEqual([]);
  });
});
