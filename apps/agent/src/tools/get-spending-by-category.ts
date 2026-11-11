import { tool } from "ai";
import { z } from "zod";

import { bounded, call, clip, compact, currentMonth, guarded, money, monthInput, percent, NAME_MAX, type ToolContext } from "./shared";

const MAX_CATEGORIES = 15;

export const getSpendingByCategory = (context: ToolContext) =>
  tool({
    description:
      "Expenses for one month grouped by category, largest first, with each category's share of the total. In the user's base currency.",
    inputSchema: z.object({ month: monthInput.optional() }),
    execute: ({ month }) =>
      guarded(context, async () => {
        const report = await context.finance.reports.spendingByCategory({ month: month ?? currentMonth(context.today) }, call(context));
        const { items, truncated } = bounded(report.categories, MAX_CATEGORIES);
        return compact({
          month: report.month,
          total: money(report.total),
          categories: items.map((row) =>
            compact({
              categoryId: row.categoryId ?? undefined,
              name: clip(row.categoryId === null ? `${row.name} (uncategorised)` : row.name, NAME_MAX),
              amount: money(row.amount),
              percent: percent(row.amount.amountMinor, report.total.amountMinor) ?? undefined,
            }),
          ),
          truncated: truncated || undefined,
        });
      }),
  });
