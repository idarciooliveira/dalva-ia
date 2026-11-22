import type { Goal } from "@mpf/finance-contract";
import { Target } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress-bar";
import { formatMonthYear } from "@/lib/dates";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";

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

interface GoalCardProps {
  goal: Goal;
  onClick?: () => void;
}

export function GoalCard({ goal, onClick }: GoalCardProps) {
  const percent = goalPercent(goal);
  const color = goal.color ?? DEFAULT_GOAL_COLOR;
  const currency = goal.targetAmount.currency;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-accent/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:p-5",
        goal.archived && "opacity-60",
      )}
    >
      <div className="flex flex-col gap-2.5 sm:gap-3">
        {/* Top row: icon + name + percentage */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
            <div
              className="inline-flex size-10 items-center justify-center rounded-xl sm:size-11"
              style={{ backgroundColor: `${color}20`, color }}
            >
              <Target className="size-4.5 sm:size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium text-foreground sm:text-base">{goal.name}</p>
                {goal.archived && (
                  <Badge variant="secondary" className="text-[10px]">
                    Archived
                  </Badge>
                )}
              </div>
              {goal.targetDate && (
                <p className="mt-0.5 text-xs text-muted-foreground sm:mt-1 sm:text-sm">
                  Due {formatMonthYear(goal.targetDate)}
                </p>
              )}
            </div>
          </div>
          <span className="shrink-0 text-lg font-semibold tabular-nums text-foreground sm:text-xl">{percent}%</span>
        </div>

        <ProgressBar percent={percent} barColor={goalProgressColor(percent)} />

        {/* Bottom row: saved + target */}
        <div className="flex justify-between gap-3 text-xs text-muted-foreground sm:text-sm">
          <span>{formatMinor(goal.currentAmount.amountMinor, currency)} saved</span>
          <span>{formatMinor(goal.targetAmount.amountMinor, currency)} target</span>
        </div>
      </div>
    </button>
  );
}
