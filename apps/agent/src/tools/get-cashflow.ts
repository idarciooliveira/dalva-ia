import { tool } from "ai";
import { z } from "zod";

import { call, currentMonth, guarded, money, monthInput, type ToolContext } from "./shared";

export const getCashflow = (context: ToolContext) =>
  tool({
    description:
      "Income, expenses and net for a month, plus a monthly income/expense trend ending at that month (oldest first). In the user's base currency.",
    inputSchema: z.object({
      month: monthInput.optional(),
      months: z.number().int().min(1).max(12).optional().describe("Months in the trend, default 6, max 12."),
    }),
    execute: ({ month, months }) =>
      guarded(context, async () => {
        const target = month ?? currentMonth(context.today);
        const report = await context.finance.reports.cashflow({ month: target, trendMonths: Math.min(months ?? 6, 12) }, call(context));
        return {
          month: target,
          income: money(report.currentMonth.income),
          expenses: money(report.currentMonth.expenses),
          net: money(report.currentMonth.net),
          trend: report.trend.slice(-12).map((row) => ({ month: row.month, income: money(row.income), expenses: money(row.expenses) })),
        };
      }),
  });
