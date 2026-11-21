/**
 * Savings goals and their contributions, ported from
 * `packages/backend/convex/domain/{savingsGoals,goalContributions}.ts` plus
 * the checks Convex kept in its API layer (`api/v1/goals.ts`). Every function
 * takes the caller's user id and only touches that user's rows; missing and
 * foreign rows are both "not found". Amounts are stored minor units
 * (value × 100), in the user's base currency.
 *
 * A contribution to a virtual goal only moves `current_amount`. One to an
 * account-linked goal (`is_virtual` false) is also a transfer into the linked
 * account, recorded on the contribution as its outgoing leg; the transfer
 * endpoints refuse to change it, and removing the contribution deletes it.
 * `transaction_id` is null when a legacy transfer is gone (the key is
 * `ON DELETE SET NULL`): removal then only moves `current_amount`.
 */
import { and, asc, eq, sql } from "drizzle-orm";

import { goalContributions, savingsGoals, transactions } from "../db/schema";
import type { Tx } from "../db/tx";
import { getAccount } from "./accounts";
import { invalid, notFound } from "./errors";
import { ownedTransaction } from "./transactions";
import { createTransfer, deleteTransferLegs } from "./transfers";

export type Goal = typeof savingsGoals.$inferSelect;
export type Contribution = typeof goalContributions.$inferSelect;

/** Convex read at most this many goals per user, and contributions per goal. */
const GOALS_LIMIT = 100;
const CONTRIBUTIONS_LIMIT = 500;

const ownedGoal = (userId: string, id: string) => and(eq(savingsGoals.id, id), eq(savingsGoals.userId, userId));

/* Goals -------------------------------------------------------------------- */

/** The user's goals, oldest first. Archived ones only with `includeArchived`. */
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

function assertTarget(amount: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw invalid("targetAmount", "Target amount must be positive");
}

export interface GoalFields {
  name: string;
  /** Stored minor units, positive. */
  targetAmount: number;
  targetDate?: string;
  isVirtual: boolean;
  linkedAccountId?: string;
  icon?: string;
  color?: string;
}

export async function createGoal(tx: Tx, userId: string, args: GoalFields): Promise<Goal> {
  assertTarget(args.targetAmount);
  if (args.linkedAccountId) await getAccount(tx, userId, args.linkedAccountId);
  const [goal] = await tx
    .insert(savingsGoals)
    .values({
      userId,
      name: args.name,
      targetAmount: args.targetAmount,
      targetDate: args.targetDate ?? null,
      isVirtual: args.isVirtual,
      linkedAccountId: args.linkedAccountId ?? null,
      icon: args.icon ?? null,
      color: args.color ?? null,
    })
    .returning();
  return goal!;
}

/** Changes only the fields given (none can be cleared). The account and `isVirtual` stay. */
export async function updateGoal(
  tx: Tx,
  userId: string,
  id: string,
  fields: Partial<Pick<GoalFields, "name" | "targetAmount" | "targetDate" | "icon" | "color">> & { archived?: boolean },
): Promise<Goal> {
  if (fields.targetAmount !== undefined) assertTarget(fields.targetAmount);
  const patch = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  if (Object.keys(patch).length === 0) return await getGoal(tx, userId, id);
  const [goal] = await tx.update(savingsGoals).set(patch).where(ownedGoal(userId, id)).returning();
  if (!goal) throw notFound("Goal");
  return goal;
}

/**
 * Delete the goal and its contributions. Transfers made by contributions stay
 * (the money did move) and become plain transfers, as in Convex.
 */
export async function deleteGoal(tx: Tx, userId: string, id: string): Promise<void> {
  await getGoal(tx, userId, id);
  await tx.delete(goalContributions).where(and(eq(goalContributions.userId, userId), eq(goalContributions.goalId, id)));
  await tx.delete(savingsGoals).where(ownedGoal(userId, id));
}

/* Contributions ------------------------------------------------------------ */

/** The goal's contributions, oldest first. */
export async function listContributions(tx: Tx, userId: string, goalId: string): Promise<Contribution[]> {
  await getGoal(tx, userId, goalId);
  return await tx
    .select()
    .from(goalContributions)
    .where(and(eq(goalContributions.userId, userId), eq(goalContributions.goalId, goalId)))
    .orderBy(asc(goalContributions.createdAt), asc(goalContributions.id))
    .limit(CONTRIBUTIONS_LIMIT);
}

/** Whether contributions to the goal are transfers into its linked account. */
export const isAccountLinked = (goal: Goal): goal is Goal & { linkedAccountId: string } =>
  !goal.isVirtual && goal.linkedAccountId !== null;

export interface ContributionFields {
  goalId: string;
  /** Stored minor units, positive. */
  amount: number;
  date: string;
  note?: string;
  /** Required for account-linked goals, refused for the others. */
  fromAccountId?: string;
}

/**
 * Record the contribution and add it to `current_amount`. For an
 * account-linked goal, first transfer the amount from `fromAccountId` into
 * the linked account ("Savings: <goal>").
 */
export async function addContribution(tx: Tx, userId: string, args: ContributionFields): Promise<Contribution> {
  if (!Number.isSafeInteger(args.amount) || args.amount <= 0) throw invalid("amount", "Amount must be positive");
  const goal = await getGoal(tx, userId, args.goalId);

  let transactionId: string | null = null;
  if (isAccountLinked(goal)) {
    if (!args.fromAccountId) {
      throw invalid("fromAccountId", "Source account is required for account-linked goal contributions");
    }
    await getAccount(tx, userId, args.fromAccountId);
    if (args.fromAccountId === goal.linkedAccountId) throw invalid("fromAccountId", "Cannot transfer to the same account");
    transactionId = await createTransfer(tx, userId, {
      amount: args.amount,
      fromAccountId: args.fromAccountId,
      toAccountId: goal.linkedAccountId,
      date: args.date,
      description: `Savings: ${goal.name}`,
      note: args.note,
    });
  } else if (args.fromAccountId) {
    throw invalid("fromAccountId", "fromAccountId only applies to account-linked goals");
  }

  const [contribution] = await tx
    .insert(goalContributions)
    .values({ userId, goalId: goal.id, amount: args.amount, date: args.date, note: args.note ?? null, transactionId })
    .returning();
  await tx
    .update(savingsGoals)
    .set({ currentAmount: sql`${savingsGoals.currentAmount} + ${args.amount}` })
    .where(ownedGoal(userId, goal.id));
  return contribution!;
}

/**
 * Delete the contribution and take it off `current_amount` (never below 0).
 * Its transfer, if any is left, is deleted with both balance effects reversed.
 */
export async function removeContribution(tx: Tx, userId: string, id: string): Promise<void> {
  const [contribution] = await tx
    .select()
    .from(goalContributions)
    .where(and(eq(goalContributions.id, id), eq(goalContributions.userId, userId)))
    .limit(1);
  if (!contribution) throw notFound("Contribution");

  if (contribution.transactionId) {
    const [leg] = await tx.select().from(transactions).where(ownedTransaction(userId, contribution.transactionId)).limit(1);
    if (leg?.type === "transfer") await deleteTransferLegs(tx, userId, leg);
  }
  await tx.delete(goalContributions).where(eq(goalContributions.id, contribution.id));
  await tx
    .update(savingsGoals)
    .set({ currentAmount: sql`greatest(0, ${savingsGoals.currentAmount} - ${contribution.amount})` })
    .where(ownedGoal(userId, contribution.goalId));
}
