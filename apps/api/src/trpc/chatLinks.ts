/**
 * Chat links from the web app (Settings → Telegram). These writes take no
 * `Idempotency-Key`: a stored replay of `createCode` would keep the raw code,
 * and the rest are safe to repeat (a second unlink is `not_found`).
 */
import { z } from "zod";

import { channel } from "../db/schema";
import * as agentStore from "../domain/agentStore";
import * as channelLinks from "../domain/channelLinks";
import { iso } from "./dto";
import { router, webRead, webWriteNoKey } from "./init";
import { byId, deleted, idSchema, noInput } from "./schemas";

export const channelSchema = z.enum(channel.enumValues);

/** A linked chat as the settings page shows it. */
export const chatLinkSchema = z.object({
  id: z.string(),
  channel: channelSchema,
  username: z.string().optional(),
  /** ISO 8601. */
  linkedAt: z.string(),
  /** True when the chat may read but not change finance data. */
  readOnly: z.boolean(),
});

const chatLinkDto = (identity: channelLinks.ChannelIdentity) => ({
  id: identity.id,
  channel: identity.channel,
  ...(identity.username ? { username: identity.username } : {}),
  linkedAt: iso(identity.linkedAt),
  readOnly: !identity.scopes.includes("finance:write"),
});

export const chatLinksRouter = router({
  /** The user's active links (at most one per channel), and the bot to message per channel, without `@`. */
  list: webRead
    .input(noInput)
    .output(z.object({ items: z.array(chatLinkSchema), botUsernames: z.record(z.string(), z.string()).optional() }))
    .query(async ({ ctx }) => {
      const { telegramBotUsername } = ctx.settings;
      const botUsernames: Record<string, string> = telegramBotUsername ? { telegram: telegramBotUsername } : {};
      return { items: (await channelLinks.listActiveForUser(ctx.tx, ctx.user.userId)).map(chatLinkDto), botUsernames };
    }),

  /**
   * A single-use code for `/start <code>`, valid 10 minutes; replaces the
   * channel's previous code. `conflict` while the channel is linked. Only its
   * hash is stored: this response is the only copy.
   */
  createCode: webWriteNoKey
    .input(
      z.strictObject({
        channel: channelSchema,
        /** The user agreed to let the bot read and change their finance data. */
        consent: z.literal(true, "Consent is required to link a chat channel"),
      }),
    )
    .output(z.object({ code: z.string(), expiresAt: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const code = channelLinks.generateLinkCode();
      const { expiresAt } = await channelLinks.storeLinkCode(ctx.tx, ctx.user.userId, {
        channel: input.channel,
        codeHash: channelLinks.hashLinkCode(code),
        now: new Date(),
      });
      return { code, expiresAt: iso(expiresAt) };
    }),

  /** Unlink a chat and delete its conversation history. */
  unlink: webWriteNoKey
    .input(byId)
    .output(deleted)
    .mutation(async ({ ctx, input }) => {
      await channelLinks.unlinkForUser(ctx.tx, ctx.user.userId, input.id, new Date());
      return { id: input.id };
    }),

  /** Read-only: the bot keeps `finance:read` only. Applies to tokens already minted. */
  setReadOnly: webWriteNoKey
    .input(z.strictObject({ id: idSchema, readOnly: z.boolean() }))
    .output(z.object({ link: chatLinkSchema }))
    .mutation(async ({ ctx, input }) => ({
      link: chatLinkDto(await channelLinks.setReadOnly(ctx.tx, ctx.user.userId, input.id, input.readOnly)),
    })),
});

export const chatHistoryRouter = router({
  /** The web "Delete chat history" button: the user's sessions, messages and pending actions, every channel. */
  delete: webWriteNoKey
    .input(noInput)
    .output(z.object({ deleted: z.literal(true) }))
    .mutation(async ({ ctx }) => {
      await agentStore.deleteUserHistory(ctx.tx, ctx.user.userId);
      return { deleted: true as const };
    }),
});
