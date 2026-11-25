/**
 * Savings goals and their contributions, in the user's base currency. A
 * virtual goal only tracks progress; an account-linked one moves each
 * contribution into its account as a transfer, so both accounts must be in
 * the base currency too.
 */
import { and, asc, eq, sql } from "drizzle-orm";

import { goalContributions, savingsGoals } from "../db/schema";
import type { Tx } from "../db/tx";
import { requireBaseCurrencyAccount } from "./accounts";
import { invalid, notFound } from "./errors";
import * as ledger from "./ledger";
import { appAmount, fitsMoney, type Money } from "./money";
import { requireBaseCurrency } from "./userProfiles";

export type Goal = typeof savingsGoals.$inferSelect;
export type Contribution = typeof goalContributions.$inferSelect;

const GOALS_LIMIT = 100;
const CONTRIBUTIONS_LIMIT = 500;

const ownedGoal = (userId: string, id: string) => and(eq(savingsGoals.id, id), eq(savingsGoals.userId, userId));

export async function listGoals(tx: Tx, userId: string, args: { includeArchived?: boolean } = {}): Promise<Goal[]> {
  return await tx
    .select()
    .from(savingsGoals)
    .where(and(eq(savingsGoals.userId, userId), args.includeArchived ? undefined : eq(savingsGoals.archived, false)))
    .orderBy(asc(savingsGoals.createdAt), asc(savingsGoals.id))
    .limit(GOALS_LIMIT);
}

export async function getGoal(tx: Tx, userId: string, id: string): Promise<Goal> {
  const [goal] = await tx.select().from(savingsGoals).where(ownedGoal(userId, id)).limit(1);
  if (!goal) throw notFound("Goal");
  return goal;
}

/** The stored target, from Money in the base currency. */
function targetOf(money: Money, currency: string): number {
  const amount = appAmount(money, currency, "targetAmount");
  if (amount <= 0) throw invalid("targetAmount", "Target amount must be positive");
  return amount;
}

/** A goal with the base currency its amounts are in. */
export interface CurrencyGoal {
  goal: Goal;
  currency: string;
}

export interface GoalFields {
  name: string;
  /** In the base currency. */
  targetAmount: Money;
  targetDate?: string;
  isVirtual: boolean;
  linkedAccountId?: string;
  icon?: string;
  color?: string;
}

export async function createGoal(tx: Tx, userId: string, args: GoalFields): Promise<CurrencyGoal> {
  const currency = await requireBaseCurrency(tx, userId);
  const targetAmount = targetOf(args.targetAmount, currency);
  if (args.linkedAccountId) await requireBaseCurrencyAccount(tx, userId, args.linkedAccountId, "linkedAccountId", currency);
  const [goal] = await tx
    .insert(savingsGoals)
    .values({
      userId,
      name: args.name,
      targetAmount,
      targetDate: args.targetDate ?? null,
      isVirtual: args.isVirtual,
      linkedAccountId: args.linkedAccountId ?? null,
      icon: args.icon ?? null,
      color: args.color ?? null,
    })
    .returning();
  return { goal: goal!, currency };
}

/** Only the given fields change. The linked account and `isVirtual` can't. */
export async function updateGoal(
  tx: Tx,
  userId: string,
  id: string,
  fields: Partial<Pick<GoalFields, "name" | "targetAmount" | "targetDate" | "icon" | "color">>,
): Promise<CurrencyGoal> {
  const current = await getGoal(tx, userId, id);
  const currency = await requireBaseCurrency(tx, userId);
  const patch = Object.fromEntries(
    Object.entries({ ...fields, targetAmount: fields.targetAmount && targetOf(fields.targetAmount, currency) }).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(patch).length === 0) return { goal: current, currency };
  const [goal] = await tx.update(savingsGoals).set(patch).where(ownedGoal(userId, id)).returning();
  return { goal: goal!, currency };
}

export async function setGoalArchived(tx: Tx, userId: string, id: string, archived: boolean): Promise<Goal> {
  const [goal] = await tx.update(savingsGoals).set({ archived }).where(ownedGoal(userId, id)).returning();
  if (!goal) throw notFound("Goal");
  return goal;
}

export async function deleteGoal(tx: Tx, userId: string, id: string): Promise<void> {
  await getGoal(tx, userId, id);
  await tx.delete(goalContributions).where(and(eq(goalContributions.userId, userId), eq(goalContributions.goalId, id)));
  await tx.delete(savingsGoals).where(ownedGoal(userId, id));
}

export async function listContributions(tx: Tx, userId: string, goalId: string): Promise<Contribution[]> {
  await getGoal(tx, userId, goalId);
  return await tx
    .select()
    .from(goalContributions)
    .where(and(eq(goalContributions.userId, userId), eq(goalContributions.goalId, goalId)))
    .orderBy(asc(goalContributions.createdAt), asc(goalContributions.id))
    .limit(CONTRIBUTIONS_LIMIT);
}

export const isAccountLinked = (goal: Goal): goal is Goal & { linkedAccountId: string } =>
  !goal.isVirtual && goal.linkedAccountId !== null;

export interface ContributionFields {
  goalId: string;
  /** Positive, in the base currency. */
  amount: Money;
  date: string;
  note?: string;
  fromAccountId?: string;
}

/** For an account-linked goal, a transfer from `fromAccountId` into the goal's account (both in the base currency). */
export async function addContribution(tx: Tx, userId: string, args: ContributionFields): Promise<{ contribution: Contribution; currency: string }> {
  const goal = await getGoal(tx, userId, args.goalId);
  const currency = await requireBaseCurrency(tx, userId);
  const amount = appAmount(args.amount, currency, "amount");
  if (amount <= 0) throw invalid("amount.amountMinor", "Amount must be positive");
  // The goal is read in this transaction: a concurrent contribution reruns it with the new total.
  if (!fitsMoney(goal.currentAmount + amount, currency)) throw invalid("amount.amountMinor", "Goal total out of range");

  let transactionId: string | null = null;
  if (isAccountLinked(goal)) {
    if (!args.fromAccountId) {
      throw invalid("fromAccountId", "Source account is required for account-linked goal contributions");
    }
    const labels = { owner: "goal" };
    const from = await requireBaseCurrencyAccount(tx, userId, args.fromAccountId, "fromAccountId", currency, labels);
    const to = await requireBaseCurrencyAccount(tx, userId, goal.linkedAccountId, "linkedAccountId", currency, labels);
    const entry = await ledger.post(tx, userId, {
      type: "transfer",
      amount: args.amount,
      fromAccountId: from,
      toAccountId: to,
      date: args.date,
      description: `Savings: ${goal.name}`,
      note: args.note,
    });
    transactionId = entry.id;
  } else if (args.fromAccountId) {
    throw invalid("fromAccountId", "fromAccountId only applies to account-linked goals");
  }

  const [contribution] = await tx
    .insert(goalContributions)
    .values({ userId, goalId: goal.id, amount, date: args.date, note: args.note ?? null, transactionId })
    .returning();
  await tx
    .update(savingsGoals)
    .set({ currentAmount: sql`${savingsGoals.currentAmount} + ${amount}` })
    .where(ownedGoal(userId, goal.id));
  return { contribution: contribution!, currency };
}

export async function removeContribution(tx: Tx, userId: string, id: string): Promise<void> {
  const [contribution] = await tx
    .select()
    .from(goalContributions)
    .where(and(eq(goalContributions.id, id), eq(goalContributions.userId, userId)))
    .limit(1);
  if (!contribution) throw notFound("Contribution");

  if (contribution.transactionId) {
    const entry = await ledger.open(tx, userId, contribution.transactionId, "goal_contribution");
    // Contributions post transfers. A legacy one pointing at any other row never moved money for the goal: keep that row.
    if (entry.kind === "transfer") await ledger.reverse(tx, userId, [entry]);
  }
  await tx.delete(goalContributions).where(eq(goalContributions.id, contribution.id));
  await tx
    .update(savingsGoals)
    .set({ currentAmount: sql`greatest(0, ${savingsGoals.currentAmount} - ${contribution.amount})` })
    .where(ownedGoal(userId, contribution.goalId));
}
