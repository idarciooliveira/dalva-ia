import { z } from "zod";

import {
  accountIdSchema,
  agentMessageIdSchema,
  agentPendingActionIdSchema,
  agentSessionIdSchema,
  categoryIdSchema,
  channelIdentityIdSchema,
  debtIdSchema,
  debtPaymentIdSchema,
  goalContributionIdSchema,
  goalIdSchema,
  isoDateSchema,
  moneyInputSchema,
  moneySchema,
  monthSchema,
  nonZeroMoneySchema,
  positiveMoneySchema,
  subcategoryIdSchema,
  transactionIdSchema,
} from "./primitives";

/*
 * Field names, enums and optionality mirror packages/backend/convex/schema.ts
 * and the domain layer. Differences are deliberate and noted inline:
 *  - ids are opaque strings (`id`, not `_id`)
 *  - every amount is `Money` (minor units + currency) instead of a bare number
 *  - optional fields are omitted, never null
 *
 * Currency rules (the domain stores bare numbers, so the server fills these in):
 *  - account balances and transactions use the account's currency
 *  - goals, debts and every aggregate/report use the user's base currency
 *  - a request `Money.currency` that differs from the target account's currency
 *    is rejected with `validation_failed`; there is no cross-currency conversion,
 *    so transfers between accounts of different currencies are rejected too
 *
 * Transfer legs and rows owned by goal contributions or debt payments are
 * visible in transaction searches but must be changed through their own
 * endpoints; `transactions.update` / `transactions.delete` on them returns `conflict`.
 *
 * Response dates are plain strings: the domain does not validate stored dates,
 * and one legacy row must not make a whole list fail. Request dates are strict.
 */

/** Dates in responses (see note above). Requests use `isoDateSchema`. */
const responseDate = z.string();

/* -------------------------------------------------------------------------- */
/*  Enums                                                                     */
/* -------------------------------------------------------------------------- */

export const accountTypeSchema = z.enum(["bank", "savings", "credit_card", "cash", "e_wallet", "loan", "investment"]);
export const categoryTypeSchema = z.enum(["income", "expense"]);
export const transactionTypeSchema = z.enum(["income", "expense", "adjustment", "transfer"]);
/** Types that can be created/edited through the transaction endpoints. Transfers have their own. */
export const writableTransactionTypeSchema = z.enum(["income", "expense", "adjustment"]);
export const debtTypeSchema = z.enum(["credit_card", "loan", "mortgage", "student_loan", "personal_loan", "other"]);

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** Query-string friendly boolean: accepts `true|false` or "true"|"false". */
const queryBoolean = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);

/** Query-string friendly bounded integer: accepts 12 or "12". */
const queryInt = (min: number, max: number) =>
  z
    .union([z.number(), z.string().regex(/^-?\d+$/).transform(Number)])
    .pipe(z.number().int().min(min).max(max));

const includeArchived = queryBoolean.optional();

const shortText = (max: number) => z.string().min(1).max(max);
const descriptionField = shortText(500);
const noteField = shortText(1000);
const payeeField = shortText(200);

const list = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });
const deleted = <T extends z.ZodType>(id: T) => z.object({ id });

const hasChangesBesidesId = (value: Record<string, unknown>) =>
  Object.entries(value).some(([key, v]) => key !== "id" && v !== undefined);
const NO_CHANGES = "Provide at least one field to change";

/* -------------------------------------------------------------------------- */
/*  Models                                                                    */
/* -------------------------------------------------------------------------- */

export const accountSchema = z.object({
  id: accountIdSchema,
  name: z.string(),
  type: accountTypeSchema,
  /** Signed; credit cards and loans are typically negative. */
  balance: moneySchema,
  theme: z.string().optional(),
  icon: z.string().optional(),
  description: z.string().optional(),
  archived: z.boolean().optional(),
});

export const categorySchema = z.object({
  id: categoryIdSchema,
  name: z.string(),
  type: categoryTypeSchema,
  icon: z.string().optional(),
  color: z.string().optional(),
  isDefault: z.boolean(),
  archived: z.boolean().optional(),
  sortOrder: z.number().optional(),
});

export const subcategorySchema = z.object({
  id: subcategoryIdSchema,
  categoryId: categoryIdSchema,
  name: z.string(),
  archived: z.boolean(),
  sortOrder: z.number(),
});

export const transactionSchema = z.object({
  id: transactionIdSchema,
  type: transactionTypeSchema,
  /** Positive for income/expense/transfer; signed for adjustments. Currency is the account's. */
  amount: moneySchema,
  accountId: accountIdSchema,
  categoryId: categoryIdSchema.optional(),
  subcategoryId: subcategoryIdSchema.optional(),
  date: responseDate,
  description: z.string().optional(),
  note: z.string().optional(),
  payee: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** Transfer legs only. `destinationAccountId` is set on the outgoing leg. */
  destinationAccountId: accountIdSchema.optional(),
  linkedTransactionId: transactionIdSchema.optional(),
  transferGroupId: z.string().optional(),
});

/** Unified view of both legs of a transfer. */
export const transferSchema = z.object({
  outgoingId: transactionIdSchema,
  incomingId: transactionIdSchema,
  transferGroupId: z.string().optional(),
  amount: moneySchema,
  fromAccountId: accountIdSchema,
  toAccountId: accountIdSchema,
  fromAccountName: z.string(),
  toAccountName: z.string(),
  date: responseDate,
  description: z.string().optional(),
  note: z.string().optional(),
});

export const goalSchema = z.object({
  id: goalIdSchema,
  name: z.string(),
  targetAmount: moneySchema,
  currentAmount: moneySchema,
  targetDate: responseDate.optional(),
  linkedAccountId: accountIdSchema.optional(),
  isVirtual: z.boolean(),
  icon: z.string().optional(),
  color: z.string().optional(),
  archived: z.boolean().optional(),
  createdAt: responseDate,
});

export const goalContributionSchema = z.object({
  id: goalContributionIdSchema,
  goalId: goalIdSchema,
  /** Positive = deposit, negative = withdrawal. */
  amount: moneySchema,
  date: responseDate,
  note: z.string().optional(),
  /** Outgoing transfer leg, present for account-linked goals. */
  transactionId: transactionIdSchema.optional(),
});

export const debtSchema = z.object({
  id: debtIdSchema,
  name: z.string(),
  debtType: debtTypeSchema,
  lender: z.string().optional(),
  originalAmount: moneySchema,
  currentBalance: moneySchema,
  /** As stored by the app (the unit is not enforced by the backend). */
  interestRate: z.number().optional(),
  minimumPayment: moneySchema.optional(),
  dueDate: responseDate.optional(),
  linkedAccountId: accountIdSchema.optional(),
  archived: z.boolean().optional(),
  createdAt: responseDate,
});

export const debtPaymentSchema = z.object({
  id: debtPaymentIdSchema,
  debtId: debtIdSchema,
  amount: moneySchema,
  principalAmount: moneySchema,
  interestAmount: moneySchema,
  date: responseDate,
  note: z.string().optional(),
  fromAccountId: accountIdSchema,
  sourceTransactionId: transactionIdSchema,
  liabilityTransactionId: transactionIdSchema.optional(),
});

/* -------------------------------------------------------------------------- */
/*  Reads: accounts, categories                                               */
/* -------------------------------------------------------------------------- */

export const accountsListRequestSchema = z.strictObject({ includeArchived });
export const accountsListResponseSchema = list(accountSchema);
export const accountGetRequestSchema = z.strictObject({ id: accountIdSchema });
export const accountGetResponseSchema = z.object({ account: accountSchema });

export const categoriesListRequestSchema = z.strictObject({ includeArchived });
export const categoriesListResponseSchema = list(categorySchema);
/** Without `categoryId`, returns subcategories of every category. */
export const subcategoriesListRequestSchema = z.strictObject({
  categoryId: categoryIdSchema.optional(),
  includeArchived,
});
export const subcategoriesListResponseSchema = list(subcategorySchema);

/* -------------------------------------------------------------------------- */
/*  Reads: transactions and reports                                           */
/* -------------------------------------------------------------------------- */

export const transactionsSearchRequestSchema = z
  .strictObject({
    dateFrom: isoDateSchema.optional(),
    dateTo: isoDateSchema.optional(),
    accountId: accountIdSchema.optional(),
    categoryId: categoryIdSchema.optional(),
    type: transactionTypeSchema.optional(),
    /** Free text over description, note and payee. */
    q: z.string().trim().min(1).max(200).optional(),
    /** Opaque; pass the previous page's `nextCursor`. */
    cursor: z.string().min(1).max(512).optional(),
    limit: queryInt(1, 100).default(25),
  })
  .refine((v) => !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo, {
    message: "dateFrom must not be after dateTo",
    path: ["dateFrom"],
  });
/** Newest first. `nextCursor` is null on the last page. */
export const transactionsSearchResponseSchema = z.object({
  items: z.array(transactionSchema),
  nextCursor: z.string().nullable(),
});

export const transactionSummaryRequestSchema = z.strictObject({ month: monthSchema });
export const transactionSummaryResponseSchema = z.object({
  month: monthSchema,
  totalIncome: moneySchema,
  totalExpenses: moneySchema,
  /** Signed sum of balance adjustments. Transfers are excluded from every total. */
  totalAdjustments: moneySchema,
  recentTransactions: z.array(transactionSchema),
});

export const spendingByCategoryRequestSchema = z.strictObject({ month: monthSchema });
export const spendingByCategoryResponseSchema = z.object({
  month: monthSchema,
  total: moneySchema,
  /** Sorted by amount, descending. `categoryId` is null for uncategorised spending. */
  categories: z.array(z.object({ categoryId: categoryIdSchema.nullable(), name: z.string(), amount: moneySchema })),
});

export const cashflowRequestSchema = z.strictObject({
  month: monthSchema,
  trendMonths: queryInt(1, 24).default(6),
});
export const cashflowResponseSchema = z.object({
  currentMonth: z.object({ income: moneySchema, expenses: moneySchema, net: moneySchema }),
  /** Oldest first, ending at the requested month. */
  trend: z.array(z.object({ month: monthSchema, income: moneySchema, expenses: moneySchema })),
});

export const netWorthRequestSchema = z.strictObject({});
export const netWorthResponseSchema = z.object({
  hasData: z.boolean(),
  totalAssets: moneySchema,
  totalDebts: moneySchema,
  netWorth: moneySchema,
});

/* -------------------------------------------------------------------------- */
/*  Reads: goals and debts                                                    */
/* -------------------------------------------------------------------------- */

export const goalsListRequestSchema = z.strictObject({ includeArchived });
export const goalsListResponseSchema = list(goalSchema);
export const goalGetRequestSchema = z.strictObject({ id: goalIdSchema });
export const goalGetResponseSchema = z.object({ goal: goalSchema });
export const goalContributionsListRequestSchema = z.strictObject({ goalId: goalIdSchema });
export const goalContributionsListResponseSchema = list(goalContributionSchema);

export const debtsListRequestSchema = z.strictObject({ includeArchived });
export const debtsListResponseSchema = list(debtSchema);
export const debtGetRequestSchema = z.strictObject({ id: debtIdSchema });
export const debtGetResponseSchema = z.object({ debt: debtSchema });
export const debtSummaryRequestSchema = z.strictObject({});
export const debtSummaryResponseSchema = z.object({
  totalOriginal: moneySchema,
  totalRemaining: moneySchema,
  recentPayment: moneySchema,
  /** Up to 5 non-archived debts (paid-off ones included), largest balance first. */
  debts: z.array(
    z.object({
      id: debtIdSchema,
      name: z.string(),
      creditor: z.string(),
      originalAmount: moneySchema,
      currentBalance: moneySchema,
      /** Rounded percentage; the server clamps to 0..100 but clients should not fail on drift. */
      percentPaid: z.number().int(),
    }),
  ),
});
export const debtPaymentsListRequestSchema = z.strictObject({ debtId: debtIdSchema });
export const debtPaymentsListResponseSchema = list(debtPaymentSchema);

/* -------------------------------------------------------------------------- */
/*  Writes: transactions                                                      */
/* -------------------------------------------------------------------------- */

export const transactionCreateRequestSchema = z
  .strictObject({
    type: writableTransactionTypeSchema,
    amount: nonZeroMoneySchema,
    accountId: accountIdSchema,
    categoryId: categoryIdSchema.optional(),
    subcategoryId: subcategoryIdSchema.optional(),
    date: isoDateSchema,
    description: descriptionField.optional(),
    note: noteField.optional(),
    payee: payeeField.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === "adjustment") {
      if (v.categoryId) ctx.addIssue({ code: "custom", message: "Adjustments cannot have a category", path: ["categoryId"] });
      if (v.subcategoryId) {
        ctx.addIssue({ code: "custom", message: "Adjustments cannot have a subcategory", path: ["subcategoryId"] });
      }
    } else if (v.amount.amountMinor < 0) {
      ctx.addIssue({ code: "custom", message: "Amount must be positive", path: ["amount", "amountMinor"] });
    }
  });
export const transactionResponseSchema = z.object({ transaction: transactionSchema });

/**
 * Partial update; omitted fields are unchanged and fields cannot be cleared.
 * The sign rule for `amount` depends on the transaction's effective type, so
 * the server enforces it (positive unless the result is an adjustment).
 */
export const transactionUpdateRequestSchema = z
  .strictObject({
    id: transactionIdSchema,
    type: writableTransactionTypeSchema.optional(),
    amount: nonZeroMoneySchema.optional(),
    accountId: accountIdSchema.optional(),
    categoryId: categoryIdSchema.optional(),
    subcategoryId: subcategoryIdSchema.optional(),
    date: isoDateSchema.optional(),
    description: descriptionField.optional(),
    note: noteField.optional(),
    payee: payeeField.optional(),
  })
  .superRefine((v, ctx) => {
    if (!hasChangesBesidesId(v)) ctx.addIssue({ code: "custom", message: NO_CHANGES });
    if (v.type === "adjustment") {
      if (v.categoryId) ctx.addIssue({ code: "custom", message: "Adjustments cannot have a category", path: ["categoryId"] });
      if (v.subcategoryId) {
        ctx.addIssue({ code: "custom", message: "Adjustments cannot have a subcategory", path: ["subcategoryId"] });
      }
    } else if (v.type !== undefined && v.amount && v.amount.amountMinor < 0) {
      ctx.addIssue({ code: "custom", message: "Amount must be positive", path: ["amount", "amountMinor"] });
    }
  });

export const transactionDeleteRequestSchema = z.strictObject({ id: transactionIdSchema });
export const transactionDeleteResponseSchema = deleted(transactionIdSchema);

/* -------------------------------------------------------------------------- */
/*  Writes: transfers                                                         */
/* -------------------------------------------------------------------------- */

export const transferCreateRequestSchema = z
  .strictObject({
    amount: positiveMoneySchema,
    fromAccountId: accountIdSchema,
    toAccountId: accountIdSchema,
    date: isoDateSchema,
    description: descriptionField.optional(),
    note: noteField.optional(),
  })
  .refine((v) => v.fromAccountId !== v.toAccountId, {
    message: "Cannot transfer to the same account",
    path: ["toAccountId"],
  });
export const transferResponseSchema = z.object({ transfer: transferSchema });

/** `id` may be either leg of the transfer. */
export const transferUpdateRequestSchema = z
  .strictObject({
    id: transactionIdSchema,
    amount: positiveMoneySchema.optional(),
    fromAccountId: accountIdSchema.optional(),
    toAccountId: accountIdSchema.optional(),
    date: isoDateSchema.optional(),
    description: descriptionField.optional(),
    note: noteField.optional(),
  })
  .superRefine((v, ctx) => {
    if (!hasChangesBesidesId(v)) ctx.addIssue({ code: "custom", message: NO_CHANGES });
    if (v.fromAccountId && v.fromAccountId === v.toAccountId) {
      ctx.addIssue({ code: "custom", message: "Cannot transfer to the same account", path: ["toAccountId"] });
    }
  });

/** `id` may be either leg of the transfer. */
export const transferDeleteRequestSchema = z.strictObject({ id: transactionIdSchema });
export const transferDeleteResponseSchema = deleted(transactionIdSchema);

/* -------------------------------------------------------------------------- */
/*  Writes: accounts, goal contributions, debt payments                       */
/* -------------------------------------------------------------------------- */

/** Signed delta applied to the balance; recorded as an `adjustment` transaction. */
export const accountAdjustRequestSchema = z.strictObject({
  id: accountIdSchema,
  amount: nonZeroMoneySchema,
  /** Defaults to today (server date). */
  date: isoDateSchema.optional(),
  note: noteField.optional(),
});
export const accountAdjustResponseSchema = z.object({ account: accountSchema });

export const goalContributionAddRequestSchema = z.strictObject({
  goalId: goalIdSchema,
  amount: positiveMoneySchema,
  date: isoDateSchema,
  note: noteField.optional(),
  /** Required when the goal is linked to an account (the contribution is a transfer). */
  fromAccountId: accountIdSchema.optional(),
});
export const goalContributionAddResponseSchema = z.object({ contribution: goalContributionSchema });

export const goalContributionRemoveRequestSchema = z.strictObject({ id: goalContributionIdSchema });
export const goalContributionRemoveResponseSchema = deleted(goalContributionIdSchema);

/**
 * `principalAmount` defaults to `amount` and `interestAmount` to 0; the two must
 * add up to `amount`. All amounts share one currency.
 */
export const debtPaymentRecordRequestSchema = z
  .strictObject({
    debtId: debtIdSchema,
    amount: positiveMoneySchema,
    principalAmount: moneyInputSchema.optional(),
    interestAmount: moneyInputSchema.optional(),
    date: isoDateSchema,
    note: noteField.optional(),
    fromAccountId: accountIdSchema,
  })
  .superRefine((v, ctx) => {
    const { amount, principalAmount, interestAmount } = v;
    for (const field of ["principalAmount", "interestAmount"] as const) {
      const money = v[field];
      if (!money) continue;
      if (money.currency !== amount.currency) {
        ctx.addIssue({ code: "custom", message: "Currency must match amount", path: [field, "currency"] });
      }
      if (money.amountMinor < 0) {
        ctx.addIssue({ code: "custom", message: "Must not be negative", path: [field, "amountMinor"] });
      }
    }
    const principal = principalAmount?.amountMinor ?? amount.amountMinor;
    const interest = interestAmount?.amountMinor ?? 0;
    if (principal + interest !== amount.amountMinor) {
      ctx.addIssue({
        code: "custom",
        message: "Principal and interest must add up to the payment amount",
        path: ["amount", "amountMinor"],
      });
    }
  });
export const debtPaymentRecordResponseSchema = z.object({ payment: debtPaymentSchema });

export const debtPaymentRemoveRequestSchema = z.strictObject({ id: debtPaymentIdSchema });
export const debtPaymentRemoveResponseSchema = deleted(debtPaymentIdSchema);

/* -------------------------------------------------------------------------- */
/*  Channels (service routes: called by the chat agent with the service key)  */
/* -------------------------------------------------------------------------- */

export const channelSchema = z.enum(["telegram"]);
/** Scopes a channel identity stores (the user can switch `finance:write` off). */
export const channelScopeSchema = z.enum(["finance:read", "finance:write"]);

/**
 * Scope on user routes for the agent store (sessions, messages, pending
 * actions, history). `channelIdentities.resolve` always grants it, read-only
 * identities included, so the bot keeps its conversation state.
 */
export const AGENT_STATE_SCOPE = "agent:state" as const;
/** Every scope a user token can carry. */
export const tokenScopeSchema = z.enum(["finance:read", "finance:write", AGENT_STATE_SCOPE]);

/** Single-use link code: 43 chars of base64url today, Telegram `start`-param safe. */
export const linkCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "Invalid link code");

/** Platform ids (Telegram user/chat ids are integers; chats can be negative). Kept as strings. */
const externalIdSchema = z.string().regex(/^-?[A-Za-z0-9_]{1,64}$/, "Invalid external id");

export const channelIdentitySchema = z.object({
  id: channelIdentityIdSchema,
  channel: channelSchema,
  externalUserId: z.string(),
  chatId: z.string(),
  username: z.string().optional(),
  scopes: z.array(channelScopeSchema),
  /** ISO 8601 timestamps. */
  linkedAt: z.string(),
  consentAt: z.string(),
});

/** Agent receives `/start <code>` from a chat and links it to the user who created the code. */
export const channelLinkRedeemRequestSchema = z.strictObject({
  channel: channelSchema,
  code: linkCodeSchema,
  externalUserId: externalIdSchema,
  chatId: externalIdSchema,
  username: z.string().min(1).max(64).optional(),
});
export const channelLinkRedeemResponseSchema = z.object({ identity: channelIdentitySchema });

/**
 * Turn a chat sender into a short-lived user token. `chatId` must be the chat
 * the identity was linked from (`not_found` otherwise), so a linked user's data
 * is never served into another chat (e.g. a group).
 */
export const channelIdentityResolveRequestSchema = z.strictObject({
  channel: channelSchema,
  externalUserId: externalIdSchema,
  chatId: externalIdSchema,
});
export const channelIdentityResolveResponseSchema = z.object({
  /** User token for the user routes (`Authorization: Bearer <token>`). */
  token: z.string(),
  /** ISO 8601; mint a new one on the next message rather than caching past this. */
  expiresAt: z.string(),
  /** Scopes of the token: the identity's finance scopes plus `agent:state`. */
  scopes: z.array(tokenScopeSchema),
  identity: channelIdentitySchema,
  profile: z.object({
    displayName: z.string().optional(),
    /** ISO 4217 code as stored on the profile. */
    baseCurrency: z.string().optional(),
  }),
});

export const channelIdentityUnlinkRequestSchema = z.strictObject({
  channel: channelSchema,
  externalUserId: externalIdSchema,
});
export const channelIdentityUnlinkResponseSchema = deleted(channelIdentityIdSchema);

/* -------------------------------------------------------------------------- */
/*  Agent store: inbound events (service key) and conversation state (token)  */
/* -------------------------------------------------------------------------- */

/** Largest stored inbound event payload, in UTF-8 bytes. */
export const AGENT_EVENT_PAYLOAD_MAX_BYTES = 32 * 1024;
/** Largest stored message `content`, in UTF-8 bytes. */
export const AGENT_MESSAGE_CONTENT_MAX_BYTES = 32 * 1024;
/** Largest pending-action `input` / `result`, as serialized JSON bytes. */
export const AGENT_ACTION_JSON_MAX_BYTES = 16 * 1024;
/** A session takes at most this many messages; past it `append` returns `conflict`. */
export const AGENT_SESSION_MAX_MESSAGES = 500;
export const AGENT_APPEND_MAX_MESSAGES = 20;

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/** A string holding valid JSON, at most `maxBytes` of UTF-8. */
const jsonString = (maxBytes: number) =>
  z
    .string()
    .refine((text) => utf8Bytes(text) <= maxBytes, `Must be at most ${maxBytes} bytes`)
    .refine((text) => {
      try {
        JSON.parse(text);
        return true;
      } catch {
        return false;
      }
    }, "Must be valid JSON");

const MAX_JSON_DEPTH = 12;

/**
 * Free-form JSON travels through Convex function arguments, which reject
 * object keys that are empty, start with `$` or `_`, are longer than 1024
 * characters or hold anything but printable ASCII, and deep nesting.
 * Refuse those up front so they are `validation_failed`, not an internal error.
 */
const isStorableKey = (key: string) =>
  key.length > 0 && key.length <= 1024 && !key.startsWith("$") && !key.startsWith("_") && /^[\x20-\x7E]+$/.test(key);

function isStorableJson(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => isStorableJson(item, depth + 1));
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    return (
      entries.length <= 1024 &&
      entries.every(([key, item]) => isStorableKey(key) && isStorableJson(item, depth + 1))
    );
  }
  return true;
}

/** A JSON value (see `isStorableJson`) whose serialized form is at most `maxBytes`. */
const boundedJson = <T extends z.ZodType>(schema: T, maxBytes: number) =>
  schema
    .refine((value) => utf8Bytes(JSON.stringify(value) ?? "") <= maxBytes, `Must serialize to at most ${maxBytes} bytes`)
    .refine(isStorableJson, "Object keys must be printable ASCII, not start with $ or _, and nesting must be at most 12 levels");

/** Platform event id (Telegram `update_id`). */
const agentEventIdSchema = z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/, "Invalid event id");

export const agentEventStatusSchema = z.enum(["received", "processing", "done", "failed"]);

const agentEventSchema = z.object({
  channel: channelSchema,
  eventId: z.string(),
  status: agentEventStatusSchema,
  attempts: z.number().int(),
  error: z.string().optional(),
  receivedAt: z.string(),
  updatedAt: z.string(),
});

/**
 * First thing the agent does with a platform event, before resolving the
 * identity: `new` means process it, `duplicate` means drop it (redelivery).
 * A duplicate that was never finished is picked up by `listRecoverable` on boot.
 */
export const agentEventClaimRequestSchema = z.strictObject({
  channel: channelSchema,
  eventId: agentEventIdSchema,
  /** The raw event as JSON, kept so a crashed event can be re-processed. Dropped when the event is `done`. */
  payload: jsonString(AGENT_EVENT_PAYLOAD_MAX_BYTES),
});
export const agentEventClaimResponseSchema = z.object({ status: z.enum(["new", "duplicate"]) });

/**
 * `processing` counts one attempt. `done` and `failed` are final (`conflict`
 * on any later update); an unknown event is `not_found`.
 */
export const agentEventUpdateStatusRequestSchema = z.strictObject({
  channel: channelSchema,
  eventId: agentEventIdSchema,
  status: z.enum(["processing", "done", "failed"]),
  error: z.string().max(500).optional(),
});
export const agentEventUpdateStatusResponseSchema = z.object({ event: agentEventSchema });

/** Events stuck in `received`/`processing` with no update for `olderThanSeconds`, oldest first. */
export const agentEventsRecoverableRequestSchema = z.strictObject({
  channel: channelSchema,
  olderThanSeconds: queryInt(0, 86_400).default(60),
  maxAttempts: queryInt(1, 20).default(3),
  limit: queryInt(1, 50).default(20),
});
export const agentEventsRecoverableResponseSchema = z.object({
  items: z.array(agentEventSchema.extend({ payload: z.string() })),
});

export const agentMessageRoleSchema = z.enum(["user", "assistant", "tool", "system"]);

export const agentSessionSchema = z.object({
  id: agentSessionIdSchema,
  channel: channelSchema,
  chatId: z.string(),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  endedAt: z.string().optional(),
  messageCount: z.number().int(),
});

/**
 * The active session of a chat. Idle longer than `idleTimeoutMinutes` ends it
 * and starts a new one (`created: true`); so does `startNew` (use it after
 * `append` returned `conflict` because the session is full). `channel` and
 * `chatId` must be the chat the token was resolved for.
 */
export const agentSessionCurrentRequestSchema = z.strictObject({
  channel: channelSchema,
  chatId: externalIdSchema,
  idleTimeoutMinutes: z.number().int().min(1).max(10_080),
  startNew: z.boolean().optional(),
});
export const agentSessionCurrentResponseSchema = z.object({ session: agentSessionSchema, created: z.boolean() });

export const agentMessageSchema = z.object({
  id: agentMessageIdSchema,
  sessionId: agentSessionIdSchema,
  role: agentMessageRoleSchema,
  /** Provider-agnostic JSON, stored as is. */
  content: z.string(),
  /** 1-based position in the session. */
  seq: z.number().int(),
  createdAt: z.string(),
});

/** The latest `limit` messages of a session, oldest first. */
export const agentMessagesListRequestSchema = z.strictObject({
  sessionId: agentSessionIdSchema,
  limit: queryInt(1, 200).default(50),
});
export const agentMessagesListResponseSchema = z.object({ items: z.array(agentMessageSchema) });

/**
 * Append in order and bump the session's `lastActivityAt`. `conflict` when the
 * session ended or the batch would pass the 500-message cap (nothing is stored).
 */
export const agentMessagesAppendRequestSchema = z.strictObject({
  sessionId: agentSessionIdSchema,
  messages: z
    .array(
      z.strictObject({
        role: agentMessageRoleSchema,
        content: jsonString(AGENT_MESSAGE_CONTENT_MAX_BYTES),
      }),
    )
    .min(1)
    .max(AGENT_APPEND_MAX_MESSAGES),
});
export const agentMessagesAppendResponseSchema = z.object({ items: z.array(agentMessageSchema) });

/**
 * Operations a pending action can carry: the user-route writes on finance data.
 * `routes.test.ts` checks this list against the route map.
 */
export const agentActionOperationSchema = z.enum([
  "accounts.adjust",
  "transactions.create",
  "transactions.update",
  "transactions.delete",
  "transfers.create",
  "transfers.update",
  "transfers.delete",
  "goalContributions.add",
  "goalContributions.remove",
  "debtPayments.record",
  "debtPayments.remove",
]);

export const agentActionStatusSchema = z.enum(["pending", "confirmed", "cancelled", "expired", "executed", "failed"]);

export const agentPendingActionSchema = z.object({
  id: agentPendingActionIdSchema,
  sessionId: agentSessionIdSchema,
  operation: agentActionOperationSchema,
  /** Flat input of the operation, as the finance client takes it. */
  input: z.record(z.string(), z.json()),
  /** Human text for the Confirm/Cancel message. */
  summary: z.string(),
  status: agentActionStatusSchema,
  expiresAt: z.string(),
  result: z.json().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const agentPendingActionResponse = z.object({ action: agentPendingActionSchema });

/**
 * `input` is validated against the operation's own request schema, so a button
 * never leads to an action that can't run. `ttlSeconds` defaults to 10 minutes.
 */
export const agentPendingActionCreateRequestSchema = z.strictObject({
  sessionId: agentSessionIdSchema,
  operation: agentActionOperationSchema,
  input: boundedJson(z.record(z.string(), z.json()), AGENT_ACTION_JSON_MAX_BYTES),
  summary: z.string().trim().min(1).max(500),
  ttlSeconds: z.number().int().min(30).max(3600).optional(),
});
export const agentPendingActionCreateResponseSchema = agentPendingActionResponse;

export const agentPendingActionGetRequestSchema = z.strictObject({ id: agentPendingActionIdSchema });
export const agentPendingActionGetResponseSchema = agentPendingActionResponse;

/**
 * Atomic `pending -> confirmed`. Returns the stored operation and input to
 * execute (use the action id as the `Idempotency-Key`). `conflict` when the
 * action is not pending or expired (an expired one is marked `expired`).
 */
export const agentPendingActionConfirmRequestSchema = z.strictObject({ id: agentPendingActionIdSchema });
export const agentPendingActionConfirmResponseSchema = agentPendingActionResponse;

/** `pending -> cancelled`. `conflict` in any other state. */
export const agentPendingActionCancelRequestSchema = z.strictObject({ id: agentPendingActionIdSchema });
export const agentPendingActionCancelResponseSchema = agentPendingActionResponse;

/** `confirmed -> executed | failed`, with what the operation returned (or its error). */
export const agentPendingActionCompleteRequestSchema = z.strictObject({
  id: agentPendingActionIdSchema,
  status: z.enum(["executed", "failed"]),
  result: boundedJson(z.json(), AGENT_ACTION_JSON_MAX_BYTES),
});
export const agentPendingActionCompleteResponseSchema = agentPendingActionResponse;

/** Delete the user's sessions, messages and pending actions, for every channel. */
export const agentHistoryDeleteRequestSchema = z.strictObject({});
export const agentHistoryDeleteResponseSchema = z.object({ deleted: z.literal(true) });

/* -------------------------------------------------------------------------- */
/*  Inferred types                                                            */
/* -------------------------------------------------------------------------- */

export type Account = z.output<typeof accountSchema>;
export type Category = z.output<typeof categorySchema>;
export type Subcategory = z.output<typeof subcategorySchema>;
export type Transaction = z.output<typeof transactionSchema>;
export type Transfer = z.output<typeof transferSchema>;
export type Goal = z.output<typeof goalSchema>;
export type GoalContribution = z.output<typeof goalContributionSchema>;
export type Debt = z.output<typeof debtSchema>;
export type DebtPayment = z.output<typeof debtPaymentSchema>;
export type AccountType = z.output<typeof accountTypeSchema>;
export type TransactionType = z.output<typeof transactionTypeSchema>;
export type DebtType = z.output<typeof debtTypeSchema>;
export type Channel = z.output<typeof channelSchema>;
export type ChannelIdentity = z.output<typeof channelIdentitySchema>;
export type TokenScope = z.output<typeof tokenScopeSchema>;
export type AgentSession = z.output<typeof agentSessionSchema>;
export type AgentMessage = z.output<typeof agentMessageSchema>;
export type AgentPendingAction = z.output<typeof agentPendingActionSchema>;
export type AgentActionOperation = z.output<typeof agentActionOperationSchema>;
