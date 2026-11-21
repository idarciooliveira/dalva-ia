/**
 * Chat links from the web app (Settings → Telegram). Ported from
 * `packages/backend/convex/channelLinks.ts` and `agentStore.deleteMyHistory`.
 * Web-only: chat tokens get `forbidden`. No `Idempotency-Key` (see the contract).
 */
import { routes } from "@mpf/finance-contract";

import * as agentStore from "../../domain/agentStore";
import * as channelLinks from "../../domain/channelLinks";
import { operation } from "../operation";
import { toId } from "./shared";

const chatLinkDto = (identity: channelLinks.ChannelIdentity) => ({
  id: identity.id,
  channel: identity.channel,
  ...(identity.username ? { username: identity.username } : {}),
  linkedAt: identity.linkedAt.toISOString(),
  readOnly: !identity.scopes.includes("finance:write"),
});

export const chatLinkOperations = {
  list: operation(routes.chatLinks.list, async (tx, user) => {
    return { items: (await channelLinks.listActiveForUser(tx, user.userId)).map(chatLinkDto) };
  }),

  createCode: operation(routes.chatLinks.createCode, async (tx, user, input) => {
    // Generated per attempt: a rerun of the transaction stores (and returns) a fresh code.
    const code = channelLinks.generateLinkCode();
    const { expiresAt } = await channelLinks.storeLinkCode(tx, user.userId, {
      channel: input.channel,
      codeHash: channelLinks.hashLinkCode(code),
      now: new Date(),
    });
    return { code, expiresAt: expiresAt.toISOString() };
  }),

  unlink: operation(routes.chatLinks.unlink, async (tx, user, input) => {
    const id = toId(input.id, "id");
    await channelLinks.unlinkForUser(tx, user.userId, id, new Date());
    return { id };
  }),

  setReadOnly: operation(routes.chatLinks.setReadOnly, async (tx, user, input) => {
    return { link: chatLinkDto(await channelLinks.setReadOnly(tx, user.userId, toId(input.id, "id"), input.readOnly)) };
  }),
};

export const chatHistoryOperations = {
  delete: operation(routes.chatHistory.delete, async (tx, user) => {
    await agentStore.deleteUserHistory(tx, user.userId);
    return { deleted: true as const };
  }),
};
