import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

/** Chat channels a user can link. Add a literal to support another one. */
export const channelValidator = v.literal("telegram");
export const agentEventStatusValidator = v.union(
  v.literal("received"),
  v.literal("processing"),
  v.literal("done"),
  v.literal("failed"),
);
export const agentMessageRoleValidator = v.union(
  v.literal("user"),
  v.literal("assistant"),
  v.literal("tool"),
  v.literal("system"),
);
export const agentActionStatusValidator = v.union(
  v.literal("pending"),
  v.literal("confirmed"),
  v.literal("cancelled"),
  v.literal("expired"),
  v.literal("executed"),
  v.literal("failed"),
);
export const channelScopeValidator = v.union(v.literal("finance:read"), v.literal("finance:write"));

export default defineSchema({
  ...authTables,

  /* ------------------------------------------------------------------ */
  /*  User profile (settings, onboarding state)                         */
  /* ------------------------------------------------------------------ */
  userProfiles: defineTable({
    userId: v.string(), // users table _id via getAuthUserId()
    name: v.optional(v.string()),
    baseCurrency: v.string(), // ISO 4217 code, e.g. "USD"
    onboardingCompleted: v.boolean(),
  }).index("by_userId", ["userId"]),

  /* ------------------------------------------------------------------ */
  /*  Financial accounts                                                */
  /* ------------------------------------------------------------------ */
  accounts: defineTable({
    userId: v.string(),
    name: v.string(),
    type: v.union(
      v.literal("bank"),
      v.literal("savings"),
      v.literal("credit_card"),
      v.literal("cash"),
      v.literal("e_wallet"),
      v.literal("loan"),
      v.literal("investment"),
    ),
    balance: v.number(), // stored in minor units (cents)
    currency: v.string(), // ISO 4217 code
    theme: v.optional(v.string()), // visual theme id (e.g. "laranja", "azul")
    icon: v.optional(v.string()), // Lucide icon name override
    description: v.optional(v.string()), // user note about the account
    archived: v.optional(v.boolean()), // soft-delete: hidden from lists by default
  }).index("by_userId", ["userId"]),

  /* ------------------------------------------------------------------ */
  /*  Transaction categories                                            */
  /* ------------------------------------------------------------------ */
  categories: defineTable({
    userId: v.string(),
    name: v.string(),
    type: v.union(v.literal("income"), v.literal("expense")),
    icon: v.optional(v.string()), // Lucide icon name (e.g. "utensils", "car")
    color: v.optional(v.string()), // Hex color (e.g. "#9FE870")
    isDefault: v.boolean(), // true = seeded by the system
    archived: v.optional(v.boolean()), // soft-delete: hidden from pickers but preserved on historical records
    sortOrder: v.optional(v.number()), // user-defined ordering within type group
  })
    .index("by_userId", ["userId"])
    .index("by_userId_and_type", ["userId", "type"]),

  /* ------------------------------------------------------------------ */
  /*  Subcategories (one level deep)                                    */
  /* ------------------------------------------------------------------ */
  subcategories: defineTable({
    userId: v.string(),
    categoryId: v.id("categories"), // parent category
    name: v.string(),
    archived: v.boolean(),
    sortOrder: v.number(),
  })
    .index("by_categoryId", ["categoryId"])
    .index("by_userId", ["userId"]),

  /* ------------------------------------------------------------------ */
  /*  Transactions                                                      */
  /* ------------------------------------------------------------------ */
  transactions: defineTable({
    userId: v.string(),
    type: v.union(
      v.literal("income"),
      v.literal("expense"),
      v.literal("adjustment"),
      v.literal("transfer"),
    ),
    amount: v.number(), // in minor units (cents); adjustments may be positive or negative
    accountId: v.id("accounts"),
    categoryId: v.optional(v.id("categories")),
    subcategoryId: v.optional(v.id("subcategories")),
    date: v.string(), // ISO date, e.g. "2026-04-05"
    description: v.optional(v.string()),
    note: v.optional(v.string()),
    payee: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),

    // Transfer-specific fields (only present on type="transfer")
    destinationAccountId: v.optional(v.id("accounts")), // the receiving account (set on the outgoing side)
    linkedTransactionId: v.optional(v.id("transactions")), // the paired transaction on the other side
    transferGroupId: v.optional(v.string()), // shared ID linking both sides of a transfer
  })
    .index("by_userId", ["userId"])
    .index("by_userId_and_date", ["userId", "date"])
    .index("by_accountId", ["accountId"])
    .index("by_categoryId", ["categoryId"])
    .index("by_transferGroupId", ["transferGroupId"])
    // Finance API search: newest first within a filter.
    .index("by_userId_and_accountId_and_date", ["userId", "accountId", "date"])
    .index("by_userId_and_categoryId_and_date", ["userId", "categoryId", "date"])
    .index("by_userId_and_type_and_date", ["userId", "type", "date"]),

  /* ------------------------------------------------------------------ */
  /*  Savings goals                                                      */
  /* ------------------------------------------------------------------ */
  savingsGoals: defineTable({
    userId: v.string(),
    name: v.string(),
    targetAmount: v.number(), // minor units (cents)
    currentAmount: v.number(), // tracked amount (cents)
    targetDate: v.optional(v.string()), // ISO date, e.g. "2026-12-31"
    linkedAccountId: v.optional(v.id("accounts")), // real account to link
    isVirtual: v.boolean(), // true = virtual tracking, false = linked to account
    icon: v.optional(v.string()), // Lucide icon name, default "target"
    color: v.optional(v.string()), // Hex color, default "#a3e635"
    archived: v.optional(v.boolean()),
    createdAt: v.string(), // ISO date of creation
  }).index("by_userId", ["userId"]),

  /* ------------------------------------------------------------------ */
  /*  Goal contributions                                                 */
  /* ------------------------------------------------------------------ */
  goalContributions: defineTable({
    userId: v.string(),
    goalId: v.id("savingsGoals"),
    amount: v.number(), // minor units (cents), positive = deposit, negative = withdrawal
    date: v.string(), // ISO date
    note: v.optional(v.string()),
    transactionId: v.optional(v.id("transactions")), // linked transfer transaction (for account-linked goals)
  })
    .index("by_userId", ["userId"])
    .index("by_goalId", ["goalId"])
    .index("by_transactionId", ["transactionId"]),

  /* ------------------------------------------------------------------ */
  /*  Debts                                                              */
  /* ------------------------------------------------------------------ */
  debts: defineTable({
    userId: v.string(),
    name: v.string(),
    debtType: v.union(
      v.literal("credit_card"),
      v.literal("loan"),
      v.literal("mortgage"),
      v.literal("student_loan"),
      v.literal("personal_loan"),
      v.literal("other"),
    ),
    lender: v.optional(v.string()),
    originalAmount: v.number(),
    currentBalance: v.number(),
    interestRate: v.optional(v.number()),
    minimumPayment: v.optional(v.number()),
    dueDate: v.optional(v.string()),
    linkedAccountId: v.optional(v.id("accounts")),
    archived: v.optional(v.boolean()),
    createdAt: v.string(),
  }).index("by_userId", ["userId"]),

  /* ------------------------------------------------------------------ */
  /*  Debt payments                                                      */
  /* ------------------------------------------------------------------ */
  debtPayments: defineTable({
    userId: v.string(),
    debtId: v.id("debts"),
    amount: v.number(),
    principalAmount: v.number(),
    interestAmount: v.number(),
    date: v.string(),
    note: v.optional(v.string()),
    fromAccountId: v.id("accounts"),
    sourceTransactionId: v.id("transactions"),
    liabilityTransactionId: v.optional(v.id("transactions")),
  })
    .index("by_userId", ["userId"])
    .index("by_debtId", ["debtId"])
    .index("by_sourceTransactionId", ["sourceTransactionId"])
    .index("by_liabilityTransactionId", ["liabilityTransactionId"]),

  /* ------------------------------------------------------------------ */
  /*  Finance API idempotency records                                    */
  /* ------------------------------------------------------------------ */
  apiIdempotencyKeys: defineTable({
    userId: v.string(),
    key: v.string(), // Idempotency-Key header
    requestHash: v.string(), // sha256 of operation + canonical input
    response: v.any(), // success `data` replayed for the same key + body
    createdAt: v.number(), // ms epoch; purged after the TTL by a cron
  })
    .index("by_userId_and_key", ["userId", "key"])
    .index("by_createdAt", ["createdAt"]),

  /* ------------------------------------------------------------------ */
  /*  Chat channel linking                                               */
  /* ------------------------------------------------------------------ */
  // Single-use codes the web app hands to the user (`/start <code>`). Only the
  // SHA-256 of the code is stored. Purged by a cron once expired.
  channelLinkCodes: defineTable({
    userId: v.string(),
    channel: channelValidator,
    codeHash: v.string(), // hex sha256 of the code
    expiresAt: v.number(), // ms epoch
    usedAt: v.optional(v.number()),
    consentAt: v.number(), // when the user ticked consent before creating the code
  })
    .index("by_codeHash", ["codeHash"])
    .index("by_userId_and_channel", ["userId", "channel"])
    .index("by_expiresAt", ["expiresAt"]),

  // A linked chat account. Active while `unlinkedAt` is unset: at most one
  // active row per (channel, externalUserId) and per (userId, channel),
  // enforced in the redeem mutation (serializable, so concurrent redeems retry).
  channelIdentities: defineTable({
    userId: v.string(),
    channel: channelValidator,
    externalUserId: v.string(),
    chatId: v.string(),
    username: v.optional(v.string()),
    scopes: v.array(channelScopeValidator),
    linkedAt: v.number(),
    consentAt: v.number(),
    unlinkedAt: v.optional(v.number()),
  })
    .index("by_channel_and_externalUserId_and_unlinkedAt", ["channel", "externalUserId", "unlinkedAt"])
    .index("by_userId_and_channel_and_unlinkedAt", ["userId", "channel", "unlinkedAt"])
    .index("by_userId_and_unlinkedAt", ["userId", "unlinkedAt"]),

  /* ------------------------------------------------------------------ */
  /*  Agent store (state for the chat agent, which is stateless)         */
  /* ------------------------------------------------------------------ */
  // Raw inbound platform events: dedupe before identity resolution, and crash
  // recovery. Holds message text, so the payload is dropped once the event is
  // finished and the row is deleted 24h after its last update (cron).
  agentInboundEvents: defineTable({
    channel: channelValidator,
    eventId: v.string(), // platform event id, unique per channel (enforced in the claim mutation)
    status: agentEventStatusValidator,
    attempts: v.number(), // bumped each time the event moves to `processing`
    payload: v.string(), // JSON, size-capped by the API; "" once done or failed
    error: v.optional(v.string()),
    receivedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_channel_and_eventId", ["channel", "eventId"])
    .index("by_channel_and_status_and_updatedAt", ["channel", "status", "updatedAt"])
    .index("by_status_and_updatedAt", ["status", "updatedAt"]),

  // One conversation in one chat. Ends after an idle timeout chosen by the
  // agent. Deleted with its messages and actions when unlinked, on request, or
  // after 30 days without activity.
  agentSessions: defineTable({
    userId: v.string(),
    identityId: v.id("channelIdentities"),
    channel: channelValidator,
    chatId: v.string(),
    startedAt: v.number(),
    lastActivityAt: v.number(),
    endedAt: v.optional(v.number()),
    messageCount: v.number(), // denormalized, for the per-session cap and the next `seq`
  })
    .index("by_userId_and_channel_and_chatId_and_endedAt", ["userId", "channel", "chatId", "endedAt"])
    .index("by_userId", ["userId"])
    .index("by_identityId", ["identityId"])
    .index("by_lastActivityAt", ["lastActivityAt"]),

  agentMessages: defineTable({
    sessionId: v.id("agentSessions"),
    userId: v.string(),
    role: agentMessageRoleValidator,
    content: v.string(), // provider-agnostic JSON, capped at 32 KB by the API
    seq: v.number(), // 1-based position in the session: the order of record
    createdAt: v.number(),
  }).index("by_sessionId_and_seq", ["sessionId", "seq"]),

  // A write the agent proposed and the user confirms with a button.
  agentPendingActions: defineTable({
    userId: v.string(),
    sessionId: v.id("agentSessions"),
    operation: v.string(), // contract operation name, e.g. "transactions.create"
    input: v.string(), // JSON, validated against the operation's request schema
    summary: v.string(),
    status: agentActionStatusValidator,
    expiresAt: v.number(),
    result: v.optional(v.string()), // JSON
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_sessionId_and_status", ["sessionId", "status"])
    .index("by_userId", ["userId"])
    .index("by_status_and_expiresAt", ["status", "expiresAt"])
    .index("by_updatedAt", ["updatedAt"]),
});
