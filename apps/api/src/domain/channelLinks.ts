import type { TokenScope } from "@mpf/finance-contract";
import { and, eq } from "drizzle-orm";

import { channelIdentities } from "../db/schema";
import type { Tx } from "../db/tx";

/**
 * Why a token minted for a chat identity can't be used now: `revoked` when the
 * identity is gone, someone else's or unlinked; `scope` when it no longer holds
 * the finance scope the route needs (switched to read-only). Run it in the
 * same transaction as the read or write it guards.
 */
export async function channelTokenProblem(
  tx: Tx,
  userId: string,
  channelIdentityId: string,
  required: TokenScope,
): Promise<"revoked" | "scope" | null> {
  const [identity] = await tx
    .select({ scopes: channelIdentities.scopes, unlinkedAt: channelIdentities.unlinkedAt })
    .from(channelIdentities)
    .where(and(eq(channelIdentities.id, channelIdentityId), eq(channelIdentities.userId, userId)))
    .limit(1);
  if (!identity || identity.unlinkedAt !== null) return "revoked";
  // The identity stores finance scopes only; `agent:state` follows from being linked.
  if (required !== "agent:state" && !identity.scopes.includes(required)) return "scope";
  return null;
}
