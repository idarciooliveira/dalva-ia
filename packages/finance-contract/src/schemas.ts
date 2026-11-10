import { z } from "zod";

import {
  accountIdSchema,
  categoryIdSchema,
  debtIdSchema,
  debtPaymentIdSchema,
  goalContributionIdSchema,
  goalIdSchema,
  isoDateSchema,
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
 */

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
  date: isoDateSchema,
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
  date: isoDateSchema,
  description: z.string().optional(),
  note: z.string().optional(),
});

export const goalSchema = z.object({
  id: goalIdSchema,
  name: z.string(),
  targetAmount: moneySchema,
  currentAmount: moneySchema,
  targetDate: isoDateSchema.optional(),
  linkedAccountId: accountIdSchema.optional(),
  isVirtual: z.boolean(),
  icon: z.string().optional(),
  color: z.string().optional(),
  archived: z.boolean().optional(),
  createdAt: isoDateSchema,
});

export const goalContributionSchema = z.object({
  id: goalContributionIdSchema,
  goalId: goalIdSchema,
  /** Positive = deposit, negative = withdrawal. */
  amount: moneySchema,
  date: isoDateSchema,
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
  dueDate: isoDateSchema.optional(),
  linkedAccountId: accountIdSchema.optional(),
  archived: z.boolean().optional(),
  createdAt: isoDateSchema,
});

export const debtPaymentSchema = z.object({
  id: debtPaymentIdSchema,
  debtId: debtIdSchema,
  amount: moneySchema,
  principalAmount: moneySchema,
  interestAmount: moneySchema,
  date: isoDateSchema,
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
  /** Up to 5 active debts, largest balance first. */
  debts: z.array(
    z.object({
      id: debtIdSchema,
      name: z.string(),
      creditor: z.string(),
      originalAmount: moneySchema,
      currentBalance: moneySchema,
      percentPaid: z.number().int().min(0).max(100),
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
    principalAmount: moneySchema.optional(),
    interestAmount: moneySchema.optional(),
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
