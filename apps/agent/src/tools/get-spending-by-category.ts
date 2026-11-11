import { tool } from "ai";
import { z } from "zod";

import { bounded, compact, currentMonth, guarded, money, monthInput, percent, type ToolContext } from "./shared";

const MAX_CATEGORIES = 15;

export const getSpendingByCategory = (context: ToolContext) =>
  tool({
    description:
      "Expenses for one month grouped by category, largest first, with each category's share of the total. In the user's base currency.",
    inputSchema: z.object({ month: monthInput.optional() }),
    execute: ({ month }) =>
      guarded(context, async () => {
        const report = await context.finance.reports.spendingByCategory({ month: month ?? currentMonth(context.today) });
        const { items, truncated } = bounded(report.categories, MAX_CATEGORIES);
        return compact({
          month: report.month,
          total: money(report.total),
          categories: items.map((row) =>
            compact({
              categoryId: row.categoryId ?? undefined,
              name: row.categoryId === null ? `${row.name} (uncategorised)` : row.name,
              amount: money(row.amount),
              percent: percent(row.amount.amountMinor, report.total.amountMinor) ?? undefined,
            }),
          ),
          truncated: truncated || undefined,
        });
      }),
  });
