import { routes } from "@mpf/finance-contract";

import * as contributions from "../../domain/goalContributions";
import * as goals from "../../domain/savingsGoals";
import { apiError, notFound, validationError } from "./errors";
import { apiMutation, apiQuery } from "./define";
import { appAmount, contributionDto, goalDto, requireBaseCurrency, requireOwned } from "./shared";

export const list = apiQuery(routes.goals.list, async (ctx, userId, input) => {
  const currency = await requireBaseCurrency(ctx, userId);
  const docs = await goals.listGoals(ctx, userId, { includeArchived: input.includeArchived });
  return { items: docs.map((g) => goalDto(g, currency)) };
});

export const get = apiQuery(routes.goals.get, async (ctx, userId, input) => {
  const goal = await requireOwned(ctx, userId, "savingsGoals", input.id, "id", "Goal");
  return { goal: goalDto(goal, await requireBaseCurrency(ctx, userId)) };
});

export const listContributions = apiQuery(routes.goalContributions.list, async (ctx, userId, input) => {
  const goal = await requireOwned(ctx, userId, "savingsGoals", input.goalId, "goalId", "Goal");
  const currency = await requireBaseCurrency(ctx, userId);
  const docs = await contributions.listContributions(ctx, userId, { goalId: goal._id });
  return { items: docs.map((c) => contributionDto(c, currency)) };
});

/**
 * Goals are in the base currency. For account-linked goals the contribution
 * is a transfer, so both accounts must be in the base currency too.
 */
export const addContribution = apiMutation(routes.goalContributions.add, async (ctx, userId, input) => {
  const goal = await requireOwned(ctx, userId, "savingsGoals", input.goalId, "goalId", "Goal");
  const currency = await requireBaseCurrency(ctx, userId);
  const amount = appAmount(input.amount, currency, "amount");

  const linked = !goal.isVirtual && goal.linkedAccountId;
  let fromAccountId;
  if (linked) {
    if (!input.fromAccountId) {
      throw validationError("fromAccountId", "Source account is required for account-linked goal contributions");
    }
    const from = await requireOwned(ctx, userId, "accounts", input.fromAccountId, "fromAccountId", "Account");
    const to = await ctx.db.get(goal.linkedAccountId!);
    if (!to || to.userId !== userId) throw notFound("Linked account");
    for (const [field, account] of [["fromAccountId", from], ["linkedAccountId", to]] as const) {
      if (account.currency !== currency) {
        throw validationError(field, `Account currency ${account.currency} differs from the goal currency ${currency}`);
      }
    }
    fromAccountId = from._id;
  } else if (input.fromAccountId) {
    throw validationError("fromAccountId", "fromAccountId only applies to account-linked goals");
  }

  const id = await contributions.addContribution(ctx, userId, {
    goalId: goal._id,
    amount,
    date: input.date,
    ...(input.note ? { note: input.note } : {}),
    ...(fromAccountId ? { fromAccountId } : {}),
  });
  const contribution = await ctx.db.get(id);
  if (!contribution) throw apiError("internal", "Contribution was not stored");
  return { contribution: contributionDto(contribution, currency) };
});

export const removeContribution = apiMutation(routes.goalContributions.remove, async (ctx, userId, input) => {
  const contribution = await requireOwned(ctx, userId, "goalContributions", input.id, "id", "Contribution");
  await contributions.removeContribution(ctx, userId, { id: contribution._id });
  return { id: contribution._id as string };
});
