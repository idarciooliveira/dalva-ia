import type { Goal } from "@/lib/api/types";

export const DEFAULT_GOAL_COLOR = "#a3e635";

/** Saved / target as a whole percentage, at most 100. */
export function goalPercent(goal: Goal): number {
  const target = goal.targetAmount.amountMinor;
  if (target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((goal.currentAmount.amountMinor / target) * 100)));
}

export function goalProgressColor(percent: number): string {
  return percent >= 80 ? "bg-wise-positive" : percent >= 50 ? "bg-wise-bright-green" : "bg-chart-2";
}

/** What the goal edit form can change. Blank date is `undefined`. */
export interface GoalFormFields {
  name: string;
  targetAmount: { amountMinor: number; currency: string };
  targetDate?: string;
  color: string;
}

/**
 * The update for an edit: only what differs from the goal as the dialog opened
 * with it, so a change made elsewhere meanwhile isn't overwritten. `null` when
 * nothing changed. A blank date is never sent (the API can't clear it).
 */
export function goalChanges(opened: Goal, fields: GoalFormFields): Partial<GoalFormFields> | null {
  const changes: Partial<GoalFormFields> = {
    name: fields.name !== opened.name ? fields.name : undefined,
    targetAmount: fields.targetAmount.amountMinor !== opened.targetAmount.amountMinor ? fields.targetAmount : undefined,
    targetDate: fields.targetDate !== undefined && fields.targetDate !== opened.targetDate ? fields.targetDate : undefined,
    color: fields.color !== (opened.color ?? DEFAULT_GOAL_COLOR) ? fields.color : undefined,
  };
  return Object.values(changes).some((v) => v !== undefined) ? changes : null;
}
