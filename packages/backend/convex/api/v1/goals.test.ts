import { routes } from "@mpf/finance-contract";
import { describe, expect, it } from "vitest";

import type { Id } from "../../_generated/dataModel";
import { clientFor, expectApiError, expectConforms, getDoc, raw, seedAccount, seedUser, setupApi, tokenFor, twoUsers, type T } from "./test.helpers";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

const seedGoal = (t: T, userId: string, extra: { linkedAccountId?: Id<"accounts">; archived?: boolean; name?: string } = {}) =>
  t.run((ctx) =>
    ctx.db.insert("savingsGoals", {
      userId,
      name: extra.name ?? "Trip",
      targetAmount: 100_000,
      currentAmount: 0,
      isVirtual: !extra.linkedAccountId,
      createdAt: "2026-01-01",
      ...(extra.linkedAccountId ? { linkedAccountId: extra.linkedAccountId } : {}),
      ...(extra.archived ? { archived: true } : {}),
    }),
  );

describe("api/v1 goals and contributions", () => {
  it("lists and gets goals in the base currency", async () => {
    const t = setupApi();
    const user = await seedUser(t, { baseCurrency: "KWD" });
    const goal = await seedGoal(t, user);
    await seedGoal(t, user, { archived: true, name: "Old" });
    const token = await tokenFor(user);
    const list = expectConforms(routes.goals.list, await raw(t, "GET", "/goals", { token })) as { items: unknown[] };
    expect(list.items).toEqual([
      { id: goal, name: "Trip", targetAmount: { amountMinor: 1_000_000, currency: "KWD" }, currentAmount: { amountMinor: 0, currency: "KWD" }, isVirtual: true, createdAt: "2026-01-01" },
    ]);
    const client = clientFor(t, token);
    expect((await client.goals.list({ includeArchived: true })).items).toHaveLength(2);
    expect((await client.goals.get({ id: goal })).goal.id).toBe(goal);
  });

  it("adds and removes a virtual contribution", async () => {
    const t = setupApi();
    const { alice, asAlice } = await twoUsers(t);
    const goal = await seedGoal(t, alice);
    const { contribution } = await asAlice.goalContributions.add({ goalId: goal, amount: usd(2_500), date: "2026-02-01", note: "Bonus" });
    expect(contribution).toEqual({ id: expect.any(String), goalId: goal, amount: usd(2_500), date: "2026-02-01", note: "Bonus" });
    expect((await getDoc(t, goal))?.currentAmount).toBe(2_500);
    expect((await asAlice.goalContributions.list({ goalId: goal })).items).toEqual([contribution]);
    expect(await asAlice.goalContributions.remove({ id: contribution.id })).toEqual({ id: contribution.id });
    expect((await getDoc(t, goal))?.currentAmount).toBe(0);
  });

  it("adds a linked contribution as a transfer and validates its accounts", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    const savings = await seedAccount(t, alice, { name: "Savings" });
    const goal = await seedGoal(t, alice, { linkedAccountId: savings });

    await expectApiError(asAlice.goalContributions.add({ goalId: goal, amount: usd(100), date: "2026-01-01" }), "validation_failed");
    const eur = await seedAccount(t, alice, { currency: "EUR" });
    await expectApiError(asAlice.goalContributions.add({ goalId: goal, amount: usd(100), date: "2026-01-01", fromAccountId: eur }), "validation_failed");
    await expectApiError(asAlice.goalContributions.add({ goalId: goal, amount: usd(100), date: "2026-01-01", fromAccountId: savings }), "validation_failed");
    await expectApiError(
      asAlice.goalContributions.add({ goalId: goal, amount: { amountMinor: 100, currency: "EUR" }, date: "2026-01-01", fromAccountId: aliceAccount }),
      "validation_failed",
    );

    const { contribution } = await asAlice.goalContributions.add({ goalId: goal, amount: usd(1_000), date: "2026-01-01", fromAccountId: aliceAccount });
    expect(contribution.transactionId).toEqual(expect.any(String));
    expect((await getDoc(t, savings))?.balance).toBe(1_000);
    await asAlice.goalContributions.remove({ id: contribution.id });
    expect((await getDoc(t, aliceAccount))?.balance).toBe(100_000);
  });

  it("rejects fromAccountId on virtual goals and needs a profile for the base currency", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    const goal = await seedGoal(t, alice);
    await expectApiError(asAlice.goalContributions.add({ goalId: goal, amount: usd(1), date: "2026-01-01", fromAccountId: aliceAccount }), "validation_failed");
    const noProfile = await seedUser(t, { profile: false });
    await expectApiError(clientFor(t, await tokenFor(noProfile)).goals.list(), "conflict", 409);
  });

  it("isolates users", async () => {
    const t = setupApi();
    const { alice, asAlice, asBob } = await twoUsers(t);
    const goal = await seedGoal(t, alice);
    const { contribution } = await asAlice.goalContributions.add({ goalId: goal, amount: usd(100), date: "2026-01-01" });
    await expectApiError(asBob.goals.get({ id: goal }), "not_found", 404);
    await expectApiError(asBob.goalContributions.list({ goalId: goal }), "not_found");
    await expectApiError(asBob.goalContributions.add({ goalId: goal, amount: usd(1), date: "2026-01-01" }), "not_found");
    await expectApiError(asBob.goalContributions.remove({ id: contribution.id }), "not_found");
    expect((await asBob.goals.list()).items).toEqual([]);
    expect((await getDoc(t, goal))?.currentAmount).toBe(100);
  });
});
