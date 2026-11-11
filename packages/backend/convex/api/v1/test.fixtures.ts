/**
 * Test-only Convex functions (two dots in the file name: never deployed, but
 * loaded by convex-test through the module glob).
 */
import { routes } from "@mpf/finance-contract";

import { apiMutation } from "./define";
import { apiError } from "./errors";

/** Writes, then fails: the write and the idempotency record must both roll back. */
export const writeThenFail = apiMutation(routes.accounts.adjust, async (ctx, userId, input) => {
  const id = ctx.db.normalizeId("accounts", input.id)!;
  await ctx.db.patch(id, { balance: 0 });
  throw apiError("conflict", `boom for ${userId}`);
});
