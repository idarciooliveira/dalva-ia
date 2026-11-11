import type { RouteDef, RouteParsedInput, ServiceRoutes } from "@mpf/finance-contract";
import type { z } from "zod";

import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import { hashLinkCode } from "../../lib/linkCodes";
import { notFound } from "./errors";
import { AGENT_STATE_SCOPE, mintUserToken } from "./tokens";

/** Lifetime of a token minted by `channelIdentities.resolve`. */
export const RESOLVED_TOKEN_TTL_SECONDS = 15 * 60;

type ServiceHandler<R extends RouteDef> = (
  ctx: ActionCtx,
  input: RouteParsedInput<R>,
) => Promise<z.input<R["response"]>>;

type ServiceImplementations = {
  [G in keyof ServiceRoutes]: {
    [O in keyof ServiceRoutes[G]]: ServiceRoutes[G][O] extends RouteDef ? ServiceHandler<ServiceRoutes[G][O]> : never;
  };
};

/**
 * Service operations run in the httpAction (hashing and token minting need
 * Web Crypto) and call one internal function each, so every check-and-write
 * stays in a single transaction.
 */
export const serviceImplementations: ServiceImplementations = {
  channelLinks: {
    redeem: async (ctx, input) => {
      const { code, ...rest } = input;
      return await ctx.runMutation(internal.api.v1.channels.redeem, { ...rest, codeHash: await hashLinkCode(code) });
    },
  },
  agentEvents: {
    claim: (ctx, input) => ctx.runMutation(internal.api.v1.agentEvents.claim, input),
    updateStatus: (ctx, input) => ctx.runMutation(internal.api.v1.agentEvents.updateStatus, input),
    listRecoverable: (ctx, input) => ctx.runQuery(internal.api.v1.agentEvents.listRecoverable, input),
  },
  channelIdentities: {
    resolve: async (ctx, input) => {
      const found = await ctx.runQuery(internal.api.v1.channels.lookup, input);
      if (!found) throw notFound("Channel identity");
      const now = Math.floor(Date.now() / 1000);
      // `agent:state` is always granted: read-only users keep their conversation state.
      const scopes = [...found.identity.scopes, AGENT_STATE_SCOPE];
      const token = await mintUserToken(found.userId, scopes, RESOLVED_TOKEN_TTL_SECONDS, {
        now,
        channelIdentityId: found.identity.id,
      });
      return {
        token,
        expiresAt: new Date((now + RESOLVED_TOKEN_TTL_SECONDS) * 1000).toISOString(),
        scopes,
        identity: found.identity,
        profile: found.profile,
      };
    },
    unlink: (ctx, input) => ctx.runMutation(internal.api.v1.channels.unlink, input),
  },
};

export function serviceImplementationFor(group: string, op: string) {
  const ops = (serviceImplementations as unknown as Record<string, Record<string, unknown>>)[group];
  return (ops?.[op] as ((ctx: ActionCtx, input: unknown) => Promise<unknown>) | undefined) ?? null;
}

