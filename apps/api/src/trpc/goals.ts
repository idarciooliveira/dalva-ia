/**
 * Savings goals and their contributions, in the base currency. A virtual goal
 * only tracks progress; an account-linked one (`isVirtual: false`) moves each
 * contribution into its account as a transfer. Fields can be changed, not cleared.
 */
import { z } from "zod";

import * as goals from "../domain/goals";
import { requireBaseCurrency } from "../domain/userProfiles";
import { contributionDto, goalDto } from "./dto";
import { financeRead, financeWrite, router, webWrite } from "./init";
import {
  byId,
  deleted,
  hasChangesBesidesId,
  idSchema,
  includeArchived,
  isoDateSchema,
  list,
  moneySchema,
  nameField,
  NO_CHANGES,
  noteField,
  positiveMoneySchema,
  responseDate,
  styleField,
} from "./schemas";

export const goalSchema = z.object({
  id: z.string(),
  name: z.string(),
  targetAmount: moneySchema,
  currentAmount: moneySchema,
  targetDate: responseDate.optional(),
  linkedAccountId: z.string().optional(),
  isVirtual: z.boolean(),
  icon: z.string().optional(),
  color: z.string().optional(),
  archived: z.boolean().optional(),
  createdAt: responseDate,
});

export const goalContributionSchema = z.object({
  id: z.string(),
  goalId: z.string(),
  /** Positive = deposit, negative = withdrawal. */
  amount: moneySchema,
  date: responseDate,
  note: z.string().optional(),
  /** Outgoing transfer leg, present for account-linked goals. */
  transactionId: z.string().optional(),
});

const goalResult = z.object({ goal: goalSchema });

export const goalContributionAddInput = z.strictObject({
  goalId: idSchema,
  amount: positiveMoneySchema,
  date: isoDateSchema,
  note: noteField.optional(),
  /** Required when the goal is linked to an account (the contribution is a transfer). */
  fromAccountId: idSchema.optional(),
});
export const goalContributionRemoveInput = byId;

export const goalsRouter = router({
  list: financeRead
    .input(includeArchived)
    .output(list(goalSchema))
    .query(async ({ ctx: { tx, user }, input }) => {
      const currency = await requireBaseCurrency(tx, user.userId);
      const rows = await goals.listGoals(tx, user.userId, { includeArchived: input.includeArchived });
      return { items: rows.map((g) => goalDto(g, currency)) };
    }),

  get: financeRead
    .input(byId)
    .output(goalResult)
    .query(async ({ ctx: { tx, user }, input }) => {
      const goal = await goals.getGoal(tx, user.userId, input.id);
      return { goal: goalDto(goal, await requireBaseCurrency(tx, user.userId)) };
    }),

  create: webWrite
    .input(
      z
        .strictObject({
          name: nameField,
          targetAmount: positiveMoneySchema,
          targetDate: isoDateSchema.optional(),
          isVirtual: z.boolean(),
          linkedAccountId: idSchema.optional(),
          icon: styleField.optional(),
          color: styleField.optional(),
        })
        .superRefine((v, ctx) => {
          if (v.isVirtual && v.linkedAccountId) {
            ctx.addIssue({ code: "custom", message: "Virtual goals have no linked account", path: ["linkedAccountId"] });
          }
          if (!v.isVirtual && !v.linkedAccountId) {
            ctx.addIssue({ code: "custom", message: "Account-linked goals need linkedAccountId", path: ["linkedAccountId"] });
          }
        }),
    )
    .output(goalResult)
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const { goal, currency } = await goals.createGoal(tx, user.userId, input);
      return { goal: goalDto(goal, currency) };
    }),

  /** Only the given fields change. The linked account and `isVirtual` can't be changed. */
  update: webWrite
    .input(
      z
        .strictObject({
          id: idSchema,
          name: nameField.optional(),
          targetAmount: positiveMoneySchema.optional(),
          targetDate: isoDateSchema.optional(),
          icon: styleField.optional(),
          color: styleField.optional(),
        })
        .refine(hasChangesBesidesId, { message: NO_CHANGES }),
    )
    .output(goalResult)
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const { id, ...fields } = input;
      const { goal, currency } = await goals.updateGoal(tx, user.userId, id, fields);
      return { goal: goalDto(goal, currency) };
    }),

  /** Archived goals are hidden from `list` unless `includeArchived`. */
  archive: webWrite
    .input(byId)
    .output(goalResult)
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const goal = await goals.setGoalArchived(tx, user.userId, input.id, true);
      return { goal: goalDto(goal, await requireBaseCurrency(tx, user.userId)) };
    }),

  restore: webWrite
    .input(byId)
    .output(goalResult)
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const goal = await goals.setGoalArchived(tx, user.userId, input.id, false);
      return { goal: goalDto(goal, await requireBaseCurrency(tx, user.userId)) };
    }),

  /** For good, with its contributions. Their transfers stay (the money did move), as plain transfers. */
  delete: webWrite
    .input(byId)
    .output(deleted)
    .mutation(async ({ ctx, input }) => {
      await goals.deleteGoal(ctx.tx, ctx.user.userId, input.id);
      return { id: input.id };
    }),
});

export const goalContributionsRouter = router({
  list: financeRead
    .input(z.strictObject({ goalId: idSchema }))
    .output(list(goalContributionSchema))
    .query(async ({ ctx: { tx, user }, input }) => {
      const rows = await goals.listContributions(tx, user.userId, input.goalId);
      const currency = await requireBaseCurrency(tx, user.userId);
      return { items: rows.map((c) => contributionDto(c, currency)) };
    }),

  /** For an account-linked goal the contribution is a transfer, so both accounts must be in the base currency too. */
  add: financeWrite
    .input(goalContributionAddInput)
    .output(z.object({ contribution: goalContributionSchema }))
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const { contribution, currency } = await goals.addContribution(tx, user.userId, input);
      return { contribution: contributionDto(contribution, currency) };
    }),

  remove: financeWrite
    .input(goalContributionRemoveInput)
    .output(deleted)
    .mutation(async ({ ctx, input }) => {
      await goals.removeContribution(ctx.tx, ctx.user.userId, input.id);
      return { id: input.id };
    }),
});
