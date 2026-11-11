import { linkCodeSchema } from "@mpf/finance-contract";

import type { InboundEvent } from "../channels/channel";
import type { FinanceClient, FinanceClients } from "./finance";
import { isFinanceError } from "./finance";

export type LinkResult = "linked" | "invalid" | "already_linked";

/**
 * `/start <code>`: link this chat to the DALVA user who created the code.
 * Redeem is single-use, so after an ambiguous failure (network, timeout) we
 * ask `resolve` whether the link went through before reporting an error.
 */
export async function redeemLink(clients: FinanceClients, event: InboundEvent, code: string): Promise<LinkResult> {
  if (!linkCodeSchema.safeParse(code).success) return "invalid";
  try {
    await clients.service.channelLinks.redeem({
      channel: event.channel,
      code,
      externalUserId: event.externalUserId,
      chatId: event.chatId,
      ...(event.username ? { username: event.username.slice(0, 64) } : {}),
    });
    return "linked";
  } catch (error) {
    // Unknown, used, expired or superseded codes are all not_found; a non-private chat is validation_failed.
    if (isFinanceError(error, "not_found", "validation_failed")) return "invalid";
    // This Telegram account or this DALVA user already has a link.
    if (isFinanceError(error, "conflict")) return "already_linked";
    if (isFinanceError(error, "network_error", "timeout", "aborted", "internal", "invalid_response")) {
      const user = await resolveUser(clients, event).catch(() => null);
      if (user) return "linked";
    }
    throw error;
  }
}

export interface ResolvedUser {
  finance: FinanceClient;
  displayName?: string;
  baseCurrency?: string;
  canWrite: boolean;
}

/**
 * Short-lived user token for this sender in this chat, or null when the chat
 * isn't linked. Called on every message: tokens last 15 minutes and unlink or
 * read-only changes must apply right away.
 */
export async function resolveUser(clients: FinanceClients, event: InboundEvent): Promise<ResolvedUser | null> {
  try {
    const resolved = await clients.service.channelIdentities.resolve({
      channel: event.channel,
      externalUserId: event.externalUserId,
      chatId: event.chatId,
    });
    return {
      finance: clients.forToken(resolved.token),
      displayName: resolved.profile.displayName,
      baseCurrency: resolved.profile.baseCurrency,
      canWrite: resolved.scopes.includes("finance:write"),
    };
  } catch (error) {
    if (isFinanceError(error, "not_found")) return null;
    throw error;
  }
}
