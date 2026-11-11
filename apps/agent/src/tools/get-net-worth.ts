import { tool } from "ai";
import { z } from "zod";

import { guarded, money, type ToolContext } from "./shared";

export const getNetWorth = (context: ToolContext) =>
  tool({
    description: "The user's net worth: total assets minus total debts, in the base currency.",
    inputSchema: z.object({}),
    execute: () =>
      guarded(context, async () => {
        const report = await context.finance.reports.netWorth({});
        return {
          hasData: report.hasData,
          assets: money(report.totalAssets),
          debts: money(report.totalDebts),
          netWorth: money(report.netWorth),
        };
      }),
  });
