import { getOptionalUserId } from "./lib/auth";
import * as dashboardDomain from "./domain/dashboard";

import { query } from "./_generated/server";

export const getNetWorth = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getOptionalUserId(ctx);
    if (!userId) {
      return {
        hasData: false,
        totalAssets: 0,
        totalDebts: 0,
        netWorth: 0,
        currency: "USD",
      };
    }

    return await dashboardDomain.getNetWorth(ctx, userId);
  },
});
