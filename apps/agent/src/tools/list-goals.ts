import { tool } from "ai";
import { z } from "zod";

import { bounded, compact, guarded, includeArchivedInput, money, percent, type ToolContext } from "./shared";

const MAX_GOALS = 30;

export const listGoals = (context: ToolContext) =>
  tool({
    description: "List the user's savings goals with target, amount saved so far, progress percent and target date.",
    inputSchema: z.object({ includeArchived: includeArchivedInput }),
    execute: ({ includeArchived }) =>
      guarded(context, async () => {
        const { items } = await context.finance.goals.list({ includeArchived: includeArchived ?? false });
        const visible = includeArchived ? items : items.filter((goal) => !goal.archived);
        const { items: goals, truncated } = bounded(visible, MAX_GOALS);
        return compact({
          goals: goals.map((goal) =>
            compact({
              id: goal.id,
              name: goal.name,
              target: money(goal.targetAmount),
              saved: money(goal.currentAmount),
              percent: percent(goal.currentAmount.amountMinor, goal.targetAmount.amountMinor) ?? undefined,
              targetDate: goal.targetDate,
              archived: goal.archived || undefined,
            }),
          ),
          truncated: truncated || undefined,
        });
      }),
  });
