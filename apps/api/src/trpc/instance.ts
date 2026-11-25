/**
 * Instance settings (Settings → Assistant in the web app): the Telegram bot
 * and the AI provider, owner only. Secrets go in and never come back out to
 * the web; the agent reads them with the service key (`agentConfig`).
 *
 * The writes take no `Idempotency-Key`: their input carries secrets, and
 * repeating one is safe (it saves the same values again).
 */
import { z } from "zod";

import { aiProvider } from "../db/schema";
import * as instance from "../domain/instance";
import { iso } from "./dto";
import { router, serviceRead, webRead, webWriteNoKey } from "./init";
import { noInput } from "./schemas";

const deliverySchema = z.enum(["webhook", "polling"]);
const aiProviderSchema = z.enum(aiProvider.enumValues);

const telegramStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unset") }),
  z.object({
    /** `unreadable`: stored under another `BETTER_AUTH_SECRET`; enter the token again. */
    status: z.enum(["configured", "unreadable"]),
    botUsername: z.string(),
    /** Last 4 characters of the token. */
    tokenHint: z.string(),
    delivery: deliverySchema,
    updatedAt: z.string(),
  }),
]);

const aiStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unset") }),
  z.object({
    status: z.enum(["configured", "unreadable"]),
    provider: aiProviderSchema,
    model: z.string(),
    keyHint: z.string(),
    updatedAt: z.string(),
  }),
]);

const telegramDto = (state: instance.TelegramState) =>
  state.status === "unset" ? state : { ...state, updatedAt: iso(state.updatedAt) };
const aiDto = (state: instance.AiState) => (state.status === "unset" ? state : { ...state, updatedAt: iso(state.updatedAt) });

/** A BotFather token: `<bot id>:<secret>`. The message never quotes the value. */
const botTokenSchema = z
  .string()
  .trim()
  .regex(/^\d{1,20}:[A-Za-z0-9_-]{30,64}$/, "Paste the token from @BotFather (it looks like 123456789:AAH...)");
const modelSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:/@+-]{1,200}$/, "Enter the provider's model id, like vendor/model");
const apiKeySchema = z.string().trim().min(8, "The API key is too short").max(1000, "The API key is too long");

export const instanceRouter = router({
  /** `owner: false` for everyone but the owner, who gets the settings (never their secrets). */
  get: webRead
    .input(noInput)
    .output(
      z.discriminatedUnion("owner", [
        z.object({ owner: z.literal(false) }),
        z.object({ owner: z.literal(true), telegram: telegramStateSchema, ai: aiStateSchema }),
      ]),
    )
    .query(async ({ ctx }) => {
      const settings = await instance.readSettings(ctx.tx, ctx.user.userId, ctx.instance);
      if (!settings) return { owner: false as const };
      return { owner: true as const, telegram: telegramDto(settings.telegram), ai: aiDto(settings.ai) };
    }),

  /**
   * Check the token with Telegram, point the bot at this instance and store
   * it. Telegram's refusal is `validation_failed` on `token`, with its reason.
   */
  saveTelegram: webWriteNoKey
    .input(z.strictObject({ token: botTokenSchema }))
    .output(z.object({ telegram: telegramStateSchema }))
    .mutation(async ({ ctx, input }) => ({
      telegram: telegramDto(await instance.saveTelegram(ctx.tx, ctx.user.userId, input.token, ctx.instance, new Date())),
    })),

  /** Delete the bot's webhook and forget the bot. `webhookDeleted: false` when Telegram didn't confirm it. */
  removeTelegram: webWriteNoKey
    .input(noInput)
    .output(z.object({ webhookDeleted: z.boolean() }))
    .mutation(async ({ ctx }) => await instance.removeTelegram(ctx.tx, ctx.user.userId, ctx.instance, new Date())),

  /** What Telegram reports for the webhook. A failed call to Telegram is `status: "error"`, not an API error. */
  telegramStatus: webRead
    .input(noInput)
    .output(
      z.discriminatedUnion("status", [
        z.object({ status: z.enum(["unset", "unreadable"]) }),
        z.object({
          status: z.literal("ok"),
          delivery: deliverySchema,
          webhookUrl: z.string().nullable(),
          webhookMatches: z.boolean(),
          pendingUpdateCount: z.number().int(),
          lastErrorAt: z.string().optional(),
          lastErrorMessage: z.string().optional(),
        }),
        z.object({ status: z.literal("error"), delivery: deliverySchema, message: z.string() }),
      ]),
    )
    .query(async ({ ctx }) => {
      const status = await instance.telegramStatus(ctx.tx, ctx.user.userId, ctx.instance);
      if (status.status !== "ok") return status;
      const { lastErrorAt, ...rest } = status;
      return { ...rest, ...(lastErrorAt ? { lastErrorAt: iso(lastErrorAt) } : {}) };
    }),

  /** Provider, model and key. Leave `apiKey` out to keep the stored key (same provider only). */
  saveAi: webWriteNoKey
    .input(z.strictObject({ provider: aiProviderSchema, model: modelSchema, apiKey: apiKeySchema.optional() }))
    .output(z.object({ ai: aiStateSchema }))
    .mutation(async ({ ctx, input }) => ({ ai: aiDto(await instance.saveAi(ctx.tx, ctx.user.userId, input, ctx.instance, new Date())) })),

  /**
   * The agent's runtime config, secrets included: service key only. A part is
   * null until the owner sets it, or while its secrets don't open.
   */
  agentConfig: serviceRead
    .input(noInput)
    .output(
      z.object({
        telegram: z
          .object({ token: z.string(), botUsername: z.string(), webhookSecret: z.string(), delivery: deliverySchema })
          .nullable(),
        ai: z.object({ provider: aiProviderSchema, model: z.string(), apiKey: z.string() }).nullable(),
      }),
    )
    .query(async ({ ctx }) => await instance.agentConfig(ctx.tx, ctx.instance)),
});
