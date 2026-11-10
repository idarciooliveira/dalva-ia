import { getAuthUserId } from "@convex-dev/auth/server";

import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Resolve the current user from the Convex Auth session.
 * Returns `null` when the request is unauthenticated.
 *
 * This is the only place (besides `auth.ts`) that talks to `@convex-dev/auth`.
 * Public query/mutation wrappers resolve the user here and hand the plain
 * `userId` string to the domain layer.
 */
export async function getOptionalUserId(
  ctx: QueryCtx | MutationCtx,
): Promise<string | null> {
  return await getAuthUserId(ctx);
}

/**
 * Resolve the current user or throw "Not authenticated".
 */
export async function requireUserId(
  ctx: QueryCtx | MutationCtx,
): Promise<string> {
  const userId = await getOptionalUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  return userId;
}
