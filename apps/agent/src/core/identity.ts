import { linkCodeSchema } from "@mpf/finance-contract";

import type { InboundEvent } from "../channels/channel";
import type { FinanceClient, FinanceClients } from "./finance";
import { isFinanceError } from "./finance";

/**
 * - `linked`: this redeem call linked the chat.
 * - `already_linked`: this Telegram account is linked already (and this code didn't do it).
 * - `account_taken`: the code's DALVA account is linked to another Telegram account.
 * - `invalid`: unknown, used, expired or superseded code.
 */
export type LinkResult = "linked" | "invalid" | "already_linked" | "account_taken";

/**
 * `/start <code>`: link this chat to the DALVA user who created the code.
 * Only a successful redeem counts as `linked`. When the redeem failed, or its
 * answer was lost, an existing link only proves the chat was linked at some
 * point, not by this code: that is `already_linked`.
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
    if (isFinanceError(error, "validation_failed")) return "invalid"; // e.g. not a private chat
    // A lookup that itself fails proves nothing: let its error reach the generic failure reply.
    const isLinked = async () => (await resolveUser(clients, event)) !== null;
    // The backend checks the code before existing links, so a linked user with a stale code lands here.
    if (isFinanceError(error, "not_found")) return (await isLinked()) ? "already_linked" : "invalid";
    // Either this Telegram account or the code's DALVA account already has a link.
    if (isFinanceError(error, "conflict")) return (await isLinked()) ? "already_linked" : "account_taken";
    // Redeem is single-use and not retry-safe: after a lost answer, an existing link is all we can know.
    if (isFinanceError(error, "network_error", "timeout", "aborted", "internal", "invalid_response")) {
      if (await isLinked()) return "already_linked";
    }
    throw error; // includes rate_limited: the handler answers it
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
