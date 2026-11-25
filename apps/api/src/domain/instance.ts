/**
 * Instance settings: the Telegram bot and the AI provider the chat agent
 * uses, set by the instance owner in the web app and read by the agent
 * through the service key. One row (`instance_settings.id = 1`).
 *
 * - Owner: the row's `owner_user_id`, else the earliest user (the first to
 *   sign up). Sign-up stores it (`claimOwner`); the migration backfilled it.
 * - Secrets (bot token, AI key, webhook secret) are sealed with a key derived
 *   from `BETTER_AUTH_SECRET`. Web reads never get them back: only whether
 *   they are set, their last 4 characters, and whether they still open
 *   (`unreadable` after the auth secret was rotated).
 * - Saving the bot checks the token (`getMe`, which also gives the username)
 *   and, behind an https `PUBLIC_URL`, points the bot at the agent
 *   (`setWebhook`, with a generated secret). Behind http (local dev) the agent
 *   polls instead and no webhook is set.
 *
 * Telegram is called inside the write's transaction: these are rare owner
 * actions, and a serialization retry just repeats the same idempotent calls.
 */
import { randomBytes } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import type { SecretBox } from "../auth/secret-box";
import type { Database } from "../db/client";
import { instanceSettings } from "../db/schema";
import type { Tx } from "../db/tx";
import { type TelegramBotApi, TelegramApiError, TELEGRAM_WEBHOOK_PATH } from "../telegram/bot-api";
import { DomainError, invalid } from "./errors";

export type AiProvider = NonNullable<(typeof instanceSettings.$inferSelect)["aiProvider"]>;
export type Delivery = "webhook" | "polling";

export interface InstanceDeps {
  /** Config `PUBLIC_URL`: the webhook is `${publicUrl}/webhooks/telegram`, and https means webhook delivery. */
  publicUrl: string;
  box: SecretBox;
  telegram: TelegramBotApi;
  /** Gets every secret read or received here, so the logger can scrub it. */
  onSecret?: (value: string) => void;
}

/** Sealing labels (GCM additional data): one per column. */
const LABEL = {
  botToken: "instance_settings.telegram_bot_token",
  webhookSecret: "instance_settings.telegram_webhook_secret",
  aiKey: "instance_settings.ai_api_key",
} as const;

type Row = typeof instanceSettings.$inferSelect;

export type TelegramState =
  | { status: "unset" }
  | { status: "configured" | "unreadable"; botUsername: string; tokenHint: string; delivery: Delivery; updatedAt: Date };

export type AiState =
  | { status: "unset" }
  | { status: "configured" | "unreadable"; provider: AiProvider; model: string; keyHint: string; updatedAt: Date };

export type TelegramStatus =
  | { status: "unset" | "unreadable" }
  | {
      status: "ok";
      delivery: Delivery;
      /** The URL Telegram delivers to (origin and path only), null when none is set. */
      webhookUrl: string | null;
      /** Whether that is this instance's webhook. */
      webhookMatches: boolean;
      pendingUpdateCount: number;
      lastErrorAt?: Date;
      lastErrorMessage?: string;
    }
  | { status: "error"; delivery: Delivery; message: string };

/** What the agent runs with. A part is null until it is set, or while its secrets don't open. */
export interface AgentConfig {
  telegram: { token: string; botUsername: string; webhookSecret: string; delivery: Delivery } | null;
  ai: { provider: AiProvider; model: string; apiKey: string } | null;
}

export const deliveryFor = (publicUrl: string): Delivery => (publicUrl.startsWith("https:") ? "webhook" : "polling");
export const webhookUrlFor = (publicUrl: string) => `${publicUrl}${TELEGRAM_WEBHOOK_PATH}`;
const hint = (secret: string) => secret.slice(-4);

/* Owner -------------------------------------------------------------------- */

const OWNER_SQL = sql`coalesce(
  (select ${instanceSettings.ownerUserId} from ${instanceSettings} where ${instanceSettings.id} = 1),
  (select id from users order by created_at, id limit 1)
)`;

export async function ownerId(tx: Tx): Promise<string | null> {
  const [row] = await tx.execute<{ owner: string | null }>(sql`select ${OWNER_SQL} as owner`);
  return row?.owner ?? null;
}

export async function isOwner(tx: Tx, userId: string): Promise<boolean> {
  return (await ownerId(tx)) === userId;
}

async function assertOwner(tx: Tx, userId: string): Promise<void> {
  if (!(await isOwner(tx, userId))) throw new DomainError("forbidden", "Only the instance owner can change these settings");
}

/** After a sign-up: store the owner if none is stored yet (the earliest user, normally the one just created). */
export async function claimOwner(db: Database | Tx): Promise<void> {
  await db.execute(sql`
    insert into instance_settings (id, owner_user_id)
    values (1, (select id from users order by created_at, id limit 1))
    on conflict (id) do update set owner_user_id = excluded.owner_user_id, updated_at = now()
    where instance_settings.owner_user_id is null
  `);
}

/* Reads -------------------------------------------------------------------- */

async function row(tx: Tx): Promise<Row | null> {
  const [found] = await tx.select().from(instanceSettings).where(eq(instanceSettings.id, 1)).limit(1);
  return found ?? null;
}

function open(deps: InstanceDeps, sealed: string | null, label: string): string | null {
  if (sealed === null) return null;
  const value = deps.box.open(sealed, label);
  if (value !== null) deps.onSecret?.(value);
  return value;
}

/** The bot's secrets, or null when unset or unreadable. */
function botSecrets(deps: InstanceDeps, settings: Row | null) {
  const token = open(deps, settings?.telegramBotTokenSealed ?? null, LABEL.botToken);
  const webhookSecret = open(deps, settings?.telegramWebhookSecretSealed ?? null, LABEL.webhookSecret);
  return token !== null && webhookSecret !== null ? { token, webhookSecret } : null;
}

function telegramState(deps: InstanceDeps, settings: Row | null): TelegramState {
  if (!settings?.telegramBotTokenSealed || !settings.telegramBotUsername) return { status: "unset" };
  return {
    status: botSecrets(deps, settings) ? "configured" : "unreadable",
    botUsername: settings.telegramBotUsername,
    tokenHint: settings.telegramBotTokenHint ?? "",
    delivery: deliveryFor(deps.publicUrl),
    updatedAt: settings.telegramUpdatedAt ?? settings.updatedAt,
  };
}

function aiState(deps: InstanceDeps, settings: Row | null): AiState {
  if (!settings?.aiProvider || !settings.aiModel || !settings.aiApiKeySealed) return { status: "unset" };
  return {
    status: open(deps, settings.aiApiKeySealed, LABEL.aiKey) === null ? "unreadable" : "configured",
    provider: settings.aiProvider,
    model: settings.aiModel,
    keyHint: settings.aiApiKeyHint ?? "",
    updatedAt: settings.aiUpdatedAt ?? settings.updatedAt,
  };
}

/** The settings as the owner sees them; null for anyone else. */
export async function readSettings(tx: Tx, userId: string, deps: InstanceDeps): Promise<{ telegram: TelegramState; ai: AiState } | null> {
  if (!(await isOwner(tx, userId))) return null;
  const settings = await row(tx);
  return { telegram: telegramState(deps, settings), ai: aiState(deps, settings) };
}

/** The bot to message, for the web's deep link. Anyone may read it: it's public on Telegram. */
export async function botUsername(tx: Tx): Promise<string | null> {
  return (await row(tx))?.telegramBotUsername ?? null;
}

export async function agentConfig(tx: Tx, deps: InstanceDeps): Promise<AgentConfig> {
  const settings = await row(tx);
  const bot = botSecrets(deps, settings);
  const apiKey = open(deps, settings?.aiApiKeySealed ?? null, LABEL.aiKey);
  return {
    telegram:
      bot && settings?.telegramBotUsername
        ? { ...bot, botUsername: settings.telegramBotUsername, delivery: deliveryFor(deps.publicUrl) }
        : null,
    ai: apiKey && settings?.aiProvider && settings.aiModel ? { provider: settings.aiProvider, model: settings.aiModel, apiKey } : null,
  };
}

/* Writes ------------------------------------------------------------------- */

async function upsert(tx: Tx, userId: string, set: Partial<typeof instanceSettings.$inferInsert>, now: Date): Promise<Row> {
  const [saved] = await tx
    .insert(instanceSettings)
    .values({ id: 1, ownerUserId: userId, ...set, updatedAt: now })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      // The caller passed `assertOwner`: store it if ownership was only implied (earliest user).
      set: { ...set, ownerUserId: sql`coalesce(${instanceSettings.ownerUserId}, ${userId}::uuid)`, updatedAt: now },
    })
    .returning();
  return saved!;
}

function telegramFailure(error: unknown, step: "token" | "webhook"): unknown {
  if (!(error instanceof TelegramApiError)) return error;
  if (error.status === null) return invalid("token", `${error.description}. Try again in a moment.`);
  if (step === "token" && (error.status === 401 || error.status === 404)) {
    return invalid("token", "Telegram rejected this token. Copy it again from @BotFather.");
  }
  return invalid("token", `Telegram refused the ${step === "token" ? "token" : "webhook"}: ${error.description}`);
}

/**
 * Check the token, point the bot at this instance (webhook delivery only) and
 * store it with a new webhook secret. The previous bot, if another one, loses
 * its webhook (best effort).
 */
export async function saveTelegram(tx: Tx, userId: string, token: string, deps: InstanceDeps, now: Date): Promise<TelegramState> {
  await assertOwner(tx, userId);
  deps.onSecret?.(token);
  const me = await deps.telegram.getMe(token).catch((error: unknown) => {
    throw telegramFailure(error, "token");
  });
  const webhookSecret = randomBytes(32).toString("base64url");
  deps.onSecret?.(webhookSecret);
  const delivery = deliveryFor(deps.publicUrl);
  if (delivery === "webhook") {
    await deps.telegram.setWebhook(token, { url: webhookUrlFor(deps.publicUrl), secretToken: webhookSecret }).catch((error: unknown) => {
      throw telegramFailure(error, "webhook");
    });
  }

  const previous = await row(tx);
  const previousToken = open(deps, previous?.telegramBotTokenSealed ?? null, LABEL.botToken);
  if (delivery === "webhook" && previousToken && previous?.telegramBotId !== me.id) {
    await deps.telegram.deleteWebhook(previousToken).catch(() => {});
  }

  const saved = await upsert(
    tx,
    userId,
    {
      telegramBotTokenSealed: deps.box.seal(token, LABEL.botToken),
      telegramBotTokenHint: hint(token),
      telegramBotId: me.id,
      telegramBotUsername: me.username,
      telegramWebhookSecretSealed: deps.box.seal(webhookSecret, LABEL.webhookSecret),
      telegramUpdatedAt: now,
    },
    now,
  );
  return telegramState(deps, saved);
}

/** Remove the bot's webhook (when the token still works) and forget the bot. */
export async function removeTelegram(tx: Tx, userId: string, deps: InstanceDeps, now: Date): Promise<{ webhookDeleted: boolean }> {
  await assertOwner(tx, userId);
  const settings = await row(tx);
  const token = open(deps, settings?.telegramBotTokenSealed ?? null, LABEL.botToken);
  let webhookDeleted = false;
  if (token && deliveryFor(deps.publicUrl) === "webhook") {
    webhookDeleted = await deps.telegram.deleteWebhook(token).then(
      () => true,
      () => false,
    );
  }
  await upsert(
    tx,
    userId,
    {
      telegramBotTokenSealed: null,
      telegramBotTokenHint: null,
      telegramBotId: null,
      telegramBotUsername: null,
      telegramWebhookSecretSealed: null,
      telegramUpdatedAt: now,
    },
    now,
  );
  return { webhookDeleted };
}

/** What Telegram reports for the bot's webhook (`getWebhookInfo`). */
export async function telegramStatus(tx: Tx, userId: string, deps: InstanceDeps): Promise<TelegramStatus> {
  await assertOwner(tx, userId);
  const settings = await row(tx);
  const state = telegramState(deps, settings);
  if (state.status !== "configured") return { status: state.status };
  const bot = botSecrets(deps, settings)!;
  const delivery = deliveryFor(deps.publicUrl);
  try {
    const info = await deps.telegram.getWebhookInfo(bot.token);
    return {
      status: "ok",
      delivery,
      webhookUrl: info.url ? describeUrl(info.url) : null,
      webhookMatches: info.url === webhookUrlFor(deps.publicUrl),
      pendingUpdateCount: info.pendingUpdateCount,
      ...(info.lastErrorDate ? { lastErrorAt: new Date(info.lastErrorDate * 1000) } : {}),
      ...(info.lastErrorMessage ? { lastErrorMessage: info.lastErrorMessage } : {}),
    };
  } catch (error) {
    if (!(error instanceof TelegramApiError)) throw error;
    return { status: "error", delivery, message: error.description };
  }
}

/** Origin and path only: a query string or credentials in a URL could be secrets. */
function describeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "(invalid URL)";
  }
}

/**
 * Set the AI provider and model. Without `apiKey` the stored key stays, which
 * needs one that still opens, for the same provider.
 */
export async function saveAi(
  tx: Tx,
  userId: string,
  input: { provider: AiProvider; model: string; apiKey?: string },
  deps: InstanceDeps,
  now: Date,
): Promise<AiState> {
  await assertOwner(tx, userId);
  if (input.apiKey === undefined) {
    const current = aiState(deps, await row(tx));
    if (current.status !== "configured" || current.provider !== input.provider) {
      throw invalid("apiKey", "Enter the API key for this provider");
    }
    // An update: the row exists, and an insert of the model alone would break the "all or nothing" check.
    const [saved] = await tx
      .update(instanceSettings)
      .set({ aiModel: input.model, aiUpdatedAt: now, updatedAt: now })
      .where(eq(instanceSettings.id, 1))
      .returning();
    return aiState(deps, saved!);
  }
  deps.onSecret?.(input.apiKey);
  const saved = await upsert(
    tx,
    userId,
    {
      aiProvider: input.provider,
      aiModel: input.model,
      aiApiKeySealed: deps.box.seal(input.apiKey, LABEL.aiKey),
      aiApiKeyHint: hint(input.apiKey),
      aiUpdatedAt: now,
    },
    now,
  );
  return aiState(deps, saved);
}
