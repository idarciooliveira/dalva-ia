import { tool } from "ai";
import { z } from "zod";

import { bounded, call, clip, compact, guarded, includeArchivedInput, money, NAME_MAX, toToolError, type ToolContext } from "./shared";

const MAX_DEBTS = 30;

export const listDebts = (context: ToolContext) =>
  tool({
    description:
      "List the user's debts (loans, credit cards, mortgages...) with remaining balance, original amount, minimum payment and due date, plus `activeSummary`: totals over active (non-archived) debts only, which can differ from the list when archived debts are included.",
    inputSchema: z.object({ includeArchived: includeArchivedInput }),
    execute: ({ includeArchived }) =>
      guarded(context, async () => {
        const [list, summary] = await Promise.all([
          context.finance.debts.list({ includeArchived: includeArchived ?? false }, call(context)),
          // The totals can fail on their own (e.g. mixed currencies) without hiding the list.
          context.finance.reports.debtSummary({}, call(context)).then(
            (report) => ({
              totalOriginal: money(report.totalOriginal),
              totalRemaining: money(report.totalRemaining),
              recentPayment: money(report.recentPayment),
            }),
            (error: unknown) => toToolError(error, context),
          ),
        ]);
        const visible = includeArchived ? list.items : list.items.filter((debt) => !debt.archived);
        const { items, truncated } = bounded(visible, MAX_DEBTS);
        return compact({
          debts: items.map((debt) =>
            compact({
              id: debt.id,
              name: clip(debt.name, NAME_MAX),
              type: debt.debtType,
              lender: clip(debt.lender, NAME_MAX),
              balance: money(debt.currentBalance),
              original: money(debt.originalAmount),
              minimumPayment: debt.minimumPayment ? money(debt.minimumPayment) : undefined,
              dueDate: debt.dueDate,
              interestRate: debt.interestRate,
              archived: debt.archived || undefined,
            }),
          ),
          activeSummary: summary,
          activeSummaryNote: includeArchived ? "Totals cover active debts only; archived debts in the list are not included." : undefined,
          truncated: truncated || undefined,
        });
      }),
  });
