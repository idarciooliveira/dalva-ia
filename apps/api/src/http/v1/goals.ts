import { routes } from "@mpf/finance-contract";

import * as goals from "../../domain/goals";
import { invalid } from "../../domain/errors";
import { appAmount, fitsMoney } from "../../domain/money";
import { operation } from "../operation";
import { requireBaseCurrency, requireBaseCurrencyAccount } from "./currency";
import { contributionDto, goalDto, optionalId, toId } from "./shared";

/** Goals and contributions are in the base currency (Convex `api/v1/goals.ts`). */
export const goalOperations = {
  list: operation(routes.goals.list, async (tx, user, input) => {
    const currency = await requireBaseCurrency(tx, user.userId);
    const rows = await goals.listGoals(tx, user.userId, { includeArchived: input.includeArchived });
    return { items: rows.map((g) => goalDto(g, currency)) };
  }),

  get: operation(routes.goals.get, async (tx, user, input) => {
    const goal = await goals.getGoal(tx, user.userId, toId(input.id, "id"));
    return { goal: goalDto(goal, await requireBaseCurrency(tx, user.userId)) };
  }),

  create: operation(routes.goals.create, async (tx, user, input) => {
    const currency = await requireBaseCurrency(tx, user.userId);
    const targetAmount = appAmount(input.targetAmount, currency, "targetAmount");
    const linkedAccountId = optionalId(input.linkedAccountId, "linkedAccountId");
    if (linkedAccountId) await requireBaseCurrencyAccount(tx, user.userId, linkedAccountId, "linkedAccountId", currency);
    const goal = await goals.createGoal(tx, user.userId, {
      name: input.name,
      targetAmount,
      targetDate: input.targetDate,
      isVirtual: input.isVirtual,
      linkedAccountId,
      icon: input.icon,
      color: input.color,
    });
    return { goal: goalDto(goal, currency) };
  }),

  update: operation(routes.goals.update, async (tx, user, input) => {
    const id = toId(input.id, "id");
    await goals.getGoal(tx, user.userId, id);
    const currency = await requireBaseCurrency(tx, user.userId);
    const goal = await goals.updateGoal(tx, user.userId, id, {
      name: input.name,
      targetAmount: input.targetAmount && appAmount(input.targetAmount, currency, "targetAmount"),
      targetDate: input.targetDate,
      icon: input.icon,
      color: input.color,
    });
    return { goal: goalDto(goal, currency) };
  }),

  archive: operation(routes.goals.archive, async (tx, user, input) => {
    const goal = await goals.updateGoal(tx, user.userId, toId(input.id, "id"), { archived: true });
    return { goal: goalDto(goal, await requireBaseCurrency(tx, user.userId)) };
  }),

  restore: operation(routes.goals.restore, async (tx, user, input) => {
    const goal = await goals.updateGoal(tx, user.userId, toId(input.id, "id"), { archived: false });
    return { goal: goalDto(goal, await requireBaseCurrency(tx, user.userId)) };
  }),

  delete: operation(routes.goals.delete, async (tx, user, input) => {
    const id = toId(input.id, "id");
    await goals.deleteGoal(tx, user.userId, id);
    return { id };
  }),
};

export const goalContributionOperations = {
  list: operation(routes.goalContributions.list, async (tx, user, input) => {
    const goalId = toId(input.goalId, "goalId");
    await goals.getGoal(tx, user.userId, goalId);
    const currency = await requireBaseCurrency(tx, user.userId);
    const rows = await goals.listContributions(tx, user.userId, goalId);
    return { items: rows.map((c) => contributionDto(c, currency)) };
  }),

  /** For an account-linked goal the contribution is a transfer, so both accounts must be in the base currency too. */
  add: operation(routes.goalContributions.add, async (tx, user, input) => {
    const goal = await goals.getGoal(tx, user.userId, toId(input.goalId, "goalId"));
    const currency = await requireBaseCurrency(tx, user.userId);
    const amount = appAmount(input.amount, currency, "amount");
    // The goal is read in this transaction: a concurrent contribution reruns it with the new total.
    if (!fitsMoney(goal.currentAmount + amount, currency)) throw invalid("amount.amountMinor", "Goal total out of range");
    const fromAccountId = optionalId(input.fromAccountId, "fromAccountId");
    if (goals.isAccountLinked(goal) && fromAccountId) {
      await requireBaseCurrencyAccount(tx, user.userId, fromAccountId, "fromAccountId", currency, { owner: "goal" });
      await requireBaseCurrencyAccount(tx, user.userId, goal.linkedAccountId, "linkedAccountId", currency, { owner: "goal" });
    }
    const contribution = await goals.addContribution(tx, user.userId, {
      goalId: goal.id,
      amount,
      date: input.date,
      note: input.note,
      fromAccountId,
    });
    return { contribution: contributionDto(contribution, currency) };
  }),

  remove: operation(routes.goalContributions.remove, async (tx, user, input) => {
    const id = toId(input.id, "id");
    await goals.removeContribution(tx, user.userId, id);
    return { id };
  }),
};
