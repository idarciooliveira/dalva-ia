/**
 * Imported Convex rows that referenced an account or transaction deleted before
 * 2026-11-11, or another user's row, hold null there: those columns are nullable.
 */
import { sql } from "drizzle-orm";
import {
  type PgColumn,
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth-schema";

export * from "./auth-schema";

const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const userId = () =>
  uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" });
const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
const money = (name: string) => bigint(name, { mode: "number" });
const day = (name: string) => date(name, { mode: "string" });
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdOn = () => day("created_on").notNull().default(sql`(now() at time zone 'utc')::date`);

const ownerKey = (table: string, t: { id: PgColumn; userId: PgColumn }) =>
  unique(`${table}_id_user_id_key`).on(t.id, t.userId);

/**
 * Migration 0003 makes these DEFERRABLE INITIALLY DEFERRED, which Drizzle can't
 * declare, and writes `onDelete: "set null"` as `SET NULL (column)` so
 * `user_id` is never nulled.
 */
const ownedBy = (
  table: string,
  column: PgColumn,
  t: { userId: PgColumn },
  target: { id: PgColumn; userId: PgColumn },
) => foreignKey({ name: `${table}_${column.name}_fk`, columns: [column, t.userId], foreignColumns: [target.id, target.userId] });

export const accountType = pgEnum("account_type", [
  "bank",
  "savings",
  "credit_card",
  "cash",
  "e_wallet",
  "loan",
  "investment",
]);
export const categoryType = pgEnum("category_type", ["income", "expense"]);
export const transactionType = pgEnum("transaction_type", ["income", "expense", "adjustment", "transfer"]);
export const debtType = pgEnum("debt_type", [
  "credit_card",
  "loan",
  "mortgage",
  "student_loan",
  "personal_loan",
  "other",
]);
export const channel = pgEnum("channel", ["telegram"]);
export const channelScope = pgEnum("channel_scope", ["finance:read", "finance:write"]);
export const aiProvider = pgEnum("ai_provider", ["gateway", "openrouter"]);
export const agentEventStatus = pgEnum("agent_event_status", ["received", "processing", "done", "failed"]);
export const agentMessageRole = pgEnum("agent_message_role", ["user", "assistant", "tool", "system"]);
export const agentActionStatus = pgEnum("agent_action_status", [
  "pending",
  "confirmed",
  "cancelled",
  "expired",
  "executed",
  "failed",
]);

export const userProfiles = pgTable(
  "user_profiles",
  {
    id: id(),
    userId: userId(),
    name: text("name"),
    baseCurrency: text("base_currency").notNull(),
    onboardingCompleted: boolean("onboarding_completed").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("user_profiles_user_id_key").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    userId: userId(),
    name: text("name").notNull(),
    type: accountType("type").notNull(),
    balance: money("balance").notNull(),
    currency: text("currency").notNull(),
    theme: text("theme"),
    icon: text("icon"),
    description: text("description"),
    archived: boolean("archived").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("accounts_user_id_idx").on(t.userId, t.createdAt), ownerKey("accounts", t)],
);

export const categories = pgTable(
  "categories",
  {
    id: id(),
    userId: userId(),
    name: text("name").notNull(),
    type: categoryType("type").notNull(),
    icon: text("icon"),
    color: text("color"),
    isDefault: boolean("is_default").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    sortOrder: integer("sort_order"),
    createdAt: createdAt(),
  },
  (t) => [
    index("categories_user_id_idx").on(t.userId, t.createdAt),
    index("categories_user_id_type_idx").on(t.userId, t.type, t.createdAt),
    ownerKey("categories", t),
  ],
);

export const subcategories = pgTable(
  "subcategories",
  {
    id: id(),
    userId: userId(),
    categoryId: uuid("category_id").notNull(),
    name: text("name").notNull(),
    archived: boolean("archived").notNull().default(false),
    sortOrder: integer("sort_order").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("subcategories_category_id_idx").on(t.categoryId, t.createdAt),
    index("subcategories_user_id_idx").on(t.userId, t.createdAt),
    ownerKey("subcategories", t),
    ownedBy("subcategories", t.categoryId, t, categories),
  ],
);

export const transactions = pgTable(
  "transactions",
  {
    id: id(),
    userId: userId(),
    type: transactionType("type").notNull(),
    amount: money("amount").notNull(),
    accountId: uuid("account_id"),
    categoryId: uuid("category_id"),
    subcategoryId: uuid("subcategory_id"),
    date: day("date").notNull(),
    description: text("description"),
    note: text("note"),
    payee: text("payee"),
    tags: text("tags").array(),
    destinationAccountId: uuid("destination_account_id"),
    linkedTransactionId: uuid("linked_transaction_id"),
    transferGroupId: uuid("transfer_group_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("transactions_user_id_date_idx").on(t.userId, t.date, t.createdAt, t.id),
    index("transactions_user_id_account_id_date_idx").on(t.userId, t.accountId, t.date, t.createdAt, t.id),
    index("transactions_user_id_category_id_date_idx").on(t.userId, t.categoryId, t.date, t.createdAt, t.id),
    index("transactions_user_id_type_date_idx").on(t.userId, t.type, t.date, t.createdAt, t.id),
    index("transactions_account_id_idx").on(t.accountId),
    index("transactions_category_id_idx").on(t.categoryId),
    index("transactions_transfer_group_id_idx").on(t.transferGroupId),
    index("transactions_subcategory_id_idx").on(t.subcategoryId),
    index("transactions_destination_account_id_idx").on(t.destinationAccountId),
    index("transactions_linked_transaction_id_idx").on(t.linkedTransactionId),
    ownerKey("transactions", t),
    ownedBy("transactions", t.accountId, t, accounts),
    ownedBy("transactions", t.categoryId, t, categories).onDelete("set null"),
    ownedBy("transactions", t.subcategoryId, t, subcategories).onDelete("set null"),
    ownedBy("transactions", t.destinationAccountId, t, accounts),
    ownedBy("transactions", t.linkedTransactionId, t, t),
  ],
);

export const savingsGoals = pgTable(
  "savings_goals",
  {
    id: id(),
    userId: userId(),
    name: text("name").notNull(),
    targetAmount: money("target_amount").notNull(),
    currentAmount: money("current_amount").notNull().default(0),
    targetDate: day("target_date"),
    linkedAccountId: uuid("linked_account_id"),
    isVirtual: boolean("is_virtual").notNull(),
    icon: text("icon"),
    color: text("color"),
    archived: boolean("archived").notNull().default(false),
    createdOn: createdOn(),
    createdAt: createdAt(),
  },
  (t) => [
    index("savings_goals_user_id_idx").on(t.userId, t.createdAt),
    index("savings_goals_linked_account_id_idx").on(t.linkedAccountId),
    ownerKey("savings_goals", t),
    ownedBy("savings_goals", t.linkedAccountId, t, accounts),
  ],
);

export const goalContributions = pgTable(
  "goal_contributions",
  {
    id: id(),
    userId: userId(),
    goalId: uuid("goal_id").notNull(),
    amount: money("amount").notNull(),
    date: day("date").notNull(),
    note: text("note"),
    transactionId: uuid("transaction_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("goal_contributions_user_id_idx").on(t.userId, t.createdAt),
    index("goal_contributions_goal_id_idx").on(t.goalId, t.createdAt),
    index("goal_contributions_transaction_id_idx").on(t.transactionId),
    ownedBy("goal_contributions", t.goalId, t, savingsGoals),
    ownedBy("goal_contributions", t.transactionId, t, transactions).onDelete("set null"),
  ],
);

export const debts = pgTable(
  "debts",
  {
    id: id(),
    userId: userId(),
    name: text("name").notNull(),
    debtType: debtType("debt_type").notNull(),
    lender: text("lender"),
    originalAmount: money("original_amount").notNull(),
    currentBalance: money("current_balance").notNull(),
    interestRate: doublePrecision("interest_rate"),
    minimumPayment: money("minimum_payment"),
    dueDate: day("due_date"),
    linkedAccountId: uuid("linked_account_id"),
    archived: boolean("archived").notNull().default(false),
    createdOn: createdOn(),
    createdAt: createdAt(),
  },
  (t) => [
    index("debts_user_id_idx").on(t.userId, t.createdAt),
    index("debts_linked_account_id_idx").on(t.linkedAccountId),
    ownerKey("debts", t),
    ownedBy("debts", t.linkedAccountId, t, accounts),
  ],
);

export const debtPayments = pgTable(
  "debt_payments",
  {
    id: id(),
    userId: userId(),
    debtId: uuid("debt_id").notNull(),
    amount: money("amount").notNull(),
    principalAmount: money("principal_amount").notNull(),
    interestAmount: money("interest_amount").notNull(),
    date: day("date").notNull(),
    note: text("note"),
    fromAccountId: uuid("from_account_id"),
    sourceTransactionId: uuid("source_transaction_id"),
    liabilityTransactionId: uuid("liability_transaction_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("debt_payments_user_id_idx").on(t.userId, t.createdAt),
    index("debt_payments_debt_id_idx").on(t.debtId, t.createdAt),
    index("debt_payments_source_transaction_id_idx").on(t.sourceTransactionId),
    index("debt_payments_liability_transaction_id_idx").on(t.liabilityTransactionId),
    index("debt_payments_from_account_id_idx").on(t.fromAccountId),
    ownedBy("debt_payments", t.debtId, t, debts),
    ownedBy("debt_payments", t.fromAccountId, t, accounts),
    ownedBy("debt_payments", t.sourceTransactionId, t, transactions),
    ownedBy("debt_payments", t.liabilityTransactionId, t, transactions),
  ],
);

export const apiIdempotencyKeys = pgTable(
  "api_idempotency_keys",
  {
    id: id(),
    userId: userId(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("api_idempotency_keys_user_id_key_key").on(t.userId, t.key),
    index("api_idempotency_keys_created_at_idx").on(t.createdAt),
  ],
);

export const channelLinkCodes = pgTable(
  "channel_link_codes",
  {
    id: id(),
    userId: userId(),
    channel: channel("channel").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: instant("expires_at").notNull(),
    usedAt: instant("used_at"),
    consentAt: instant("consent_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("channel_link_codes_code_hash_key").on(t.codeHash),
    uniqueIndex("channel_link_codes_user_id_channel_key").on(t.userId, t.channel),
    index("channel_link_codes_expires_at_idx").on(t.expiresAt),
  ],
);

export const channelIdentities = pgTable(
  "channel_identities",
  {
    id: id(),
    userId: userId(),
    channel: channel("channel").notNull(),
    externalUserId: text("external_user_id").notNull(),
    chatId: text("chat_id").notNull(),
    username: text("username"),
    scopes: channelScope("scopes").array().notNull(),
    linkedAt: instant("linked_at").notNull(),
    consentAt: instant("consent_at").notNull(),
    unlinkedAt: instant("unlinked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("channel_identities_active_external_key")
      .on(t.channel, t.externalUserId)
      .where(sql`${t.unlinkedAt} is null`),
    uniqueIndex("channel_identities_active_user_key")
      .on(t.userId, t.channel)
      .where(sql`${t.unlinkedAt} is null`),
    index("channel_identities_user_id_idx").on(t.userId),
    ownerKey("channel_identities", t),
  ],
);

export const agentInboundEvents = pgTable(
  "agent_inbound_events",
  {
    id: id(),
    channel: channel("channel").notNull(),
    eventId: text("event_id").notNull(),
    status: agentEventStatus("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    payload: text("payload").notNull(),
    error: text("error"),
    receivedAt: instant("received_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("agent_inbound_events_channel_event_id_key").on(t.channel, t.eventId),
    index("agent_inbound_events_channel_status_updated_at_idx").on(t.channel, t.status, t.updatedAt),
    index("agent_inbound_events_updated_at_idx").on(t.updatedAt),
  ],
);

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: id(),
    userId: userId(),
    identityId: uuid("identity_id").notNull(),
    channel: channel("channel").notNull(),
    chatId: text("chat_id").notNull(),
    startedAt: instant("started_at").notNull(),
    lastActivityAt: instant("last_activity_at").notNull(),
    endedAt: instant("ended_at"),
    messageCount: integer("message_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_sessions_active_chat_idx")
      .on(t.userId, t.channel, t.chatId)
      .where(sql`${t.endedAt} is null`),
    index("agent_sessions_user_id_idx").on(t.userId),
    index("agent_sessions_identity_id_idx").on(t.identityId),
    index("agent_sessions_last_activity_at_idx").on(t.lastActivityAt),
    ownerKey("agent_sessions", t),
    foreignKey({
      name: "agent_sessions_identity_id_fk",
      columns: [t.identityId, t.userId],
      foreignColumns: [channelIdentities.id, channelIdentities.userId],
    }),
  ],
);

export const agentMessages = pgTable(
  "agent_messages",
  {
    id: id(),
    userId: userId(),
    sessionId: uuid("session_id").notNull(),
    role: agentMessageRole("role").notNull(),
    content: text("content").notNull(),
    seq: integer("seq").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("agent_messages_session_id_seq_key").on(t.sessionId, t.seq),
    foreignKey({
      name: "agent_messages_session_id_fk",
      columns: [t.sessionId, t.userId],
      foreignColumns: [agentSessions.id, agentSessions.userId],
    }).onDelete("cascade"),
  ],
);

export const agentPendingActions = pgTable(
  "agent_pending_actions",
  {
    id: id(),
    userId: userId(),
    sessionId: uuid("session_id").notNull(),
    clientKey: text("client_key"),
    operation: text("operation").notNull(),
    input: text("input").notNull(),
    summary: text("summary").notNull(),
    status: agentActionStatus("status").notNull(),
    expiresAt: instant("expires_at").notNull(),
    result: text("result"),
    createdAt: createdAt(),
    updatedAt: instant("updated_at").notNull(),
  },
  (t) => [
    index("agent_pending_actions_session_id_status_idx").on(t.sessionId, t.status),
    index("agent_pending_actions_user_id_client_key_idx").on(t.userId, t.clientKey),
    index("agent_pending_actions_pending_expires_at_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'pending'`),
    index("agent_pending_actions_updated_at_idx").on(t.updatedAt),
    foreignKey({
      name: "agent_pending_actions_session_id_fk",
      columns: [t.sessionId, t.userId],
      foreignColumns: [agentSessions.id, agentSessions.userId],
    }).onDelete("cascade"),
  ],
);

/**
 * One row (`id = 1`): the instance's own settings, edited by its owner in the
 * web app (Settings). The owner is the first user who signed up. `*_sealed`
 * columns hold secrets encrypted with a key derived from `BETTER_AUTH_SECRET`
 * (`src/auth/secret-box.ts`); `*_hint` keeps their last 4 characters to show.
 */
export const instanceSettings = pgTable(
  "instance_settings",
  {
    id: smallint("id").primaryKey().default(1),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "restrict" }),
    telegramBotTokenSealed: text("telegram_bot_token_sealed"),
    telegramBotTokenHint: text("telegram_bot_token_hint"),
    telegramBotId: bigint("telegram_bot_id", { mode: "number" }),
    telegramBotUsername: text("telegram_bot_username"),
    telegramWebhookSecretSealed: text("telegram_webhook_secret_sealed"),
    telegramUpdatedAt: instant("telegram_updated_at"),
    aiProvider: aiProvider("ai_provider"),
    aiModel: text("ai_model"),
    aiApiKeySealed: text("ai_api_key_sealed"),
    aiApiKeyHint: text("ai_api_key_hint"),
    aiUpdatedAt: instant("ai_updated_at"),
    createdAt: createdAt(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("instance_settings_singleton", sql`${t.id} = 1`),
    check(
      "instance_settings_telegram_complete",
      sql`(${t.telegramBotTokenSealed} is null) = (${t.telegramBotUsername} is null) and (${t.telegramBotTokenSealed} is null) = (${t.telegramWebhookSecretSealed} is null)`,
    ),
    check(
      "instance_settings_ai_complete",
      sql`(${t.aiProvider} is null) = (${t.aiModel} is null) and (${t.aiProvider} is null) = (${t.aiApiKeySealed} is null)`,
    ),
  ],
);
