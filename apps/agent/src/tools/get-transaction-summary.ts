import { tool } from "ai";
import { z } from "zod";

import { clip, compact, currentMonth, guarded, money, monthInput, type ToolContext } from "./shared";

const MAX_RECENT = 5;

export const getTransactionSummary = (context: ToolContext) =>
  tool({
    description:
      "Income, expense and balance-adjustment totals for one month (transfers excluded), in the user's base currency, plus a few recent transactions.",
    inputSchema: z.object({ month: monthInput.optional() }),
    execute: ({ month }) =>
      guarded(context, async () => {
        const summary = await context.finance.reports.transactionSummary({ month: month ?? currentMonth(context.today) });
        return {
          month: summary.month,
          income: money(summary.totalIncome),
          expenses: money(summary.totalExpenses),
          adjustments: money(summary.totalAdjustments),
          recent: summary.recentTransactions.slice(0, MAX_RECENT).map((tx) =>
            compact({ date: tx.date, type: tx.type, amount: money(tx.amount), description: clip(tx.description) }),
          ),
        };
      }),
  });
