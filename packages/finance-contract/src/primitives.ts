import { z } from "zod";

/* -------------------------------------------------------------------------- */
/*  IDs: opaque, branded strings. No Convex types leak through the contract.  */
/* -------------------------------------------------------------------------- */

/** URL-safe on purpose: ids go into path segments, so `.`, `..`, `/` and `%` must never validate. */
const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "Invalid id");

export const accountIdSchema = opaqueId.brand<"AccountId">();
export const categoryIdSchema = opaqueId.brand<"CategoryId">();
export const subcategoryIdSchema = opaqueId.brand<"SubcategoryId">();
export const transactionIdSchema = opaqueId.brand<"TransactionId">();
export const goalIdSchema = opaqueId.brand<"GoalId">();
export const goalContributionIdSchema = opaqueId.brand<"GoalContributionId">();
export const debtIdSchema = opaqueId.brand<"DebtId">();
export const debtPaymentIdSchema = opaqueId.brand<"DebtPaymentId">();
export const channelIdentityIdSchema = opaqueId.brand<"ChannelIdentityId">();
export const agentSessionIdSchema = opaqueId.brand<"AgentSessionId">();
export const agentMessageIdSchema = opaqueId.brand<"AgentMessageId">();
export const agentPendingActionIdSchema = opaqueId.brand<"AgentPendingActionId">();

export type AccountId = z.output<typeof accountIdSchema>;
export type CategoryId = z.output<typeof categoryIdSchema>;
export type SubcategoryId = z.output<typeof subcategoryIdSchema>;
export type TransactionId = z.output<typeof transactionIdSchema>;
export type GoalId = z.output<typeof goalIdSchema>;
export type GoalContributionId = z.output<typeof goalContributionIdSchema>;
export type DebtId = z.output<typeof debtIdSchema>;
export type DebtPaymentId = z.output<typeof debtPaymentIdSchema>;
export type ChannelIdentityId = z.output<typeof channelIdentityIdSchema>;
export type AgentSessionId = z.output<typeof agentSessionIdSchema>;
export type AgentMessageId = z.output<typeof agentMessageIdSchema>;
export type AgentPendingActionId = z.output<typeof agentPendingActionIdSchema>;

/* -------------------------------------------------------------------------- */
/*  Dates                                                                     */
/* -------------------------------------------------------------------------- */

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Calendar date, `YYYY-MM-DD`. Validated against the real calendar. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((value) => {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
  }, "Not a real calendar date");

/** Calendar month, `YYYY-MM`. */
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM");

export type IsoDate = z.output<typeof isoDateSchema>;
export type Month = z.output<typeof monthSchema>;

/* -------------------------------------------------------------------------- */
/*  Money: integer minor units + ISO 4217 currency                            */
/* -------------------------------------------------------------------------- */

/** Three uppercase letters. Format-checked, not checked against the ISO registry. */
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "Expected ISO 4217 code, e.g. USD");

/**
 * Signed integer minor units in a currency, used in responses. Tolerates extra
 * keys so fields can be added to Money later without breaking old clients.
 *
 * "Minor unit" is the ISO 4217 one: 10^-exponent of the major unit (JPY 0,
 * USD 2, KWD 3). See `currencyExponent`.
 */
export const moneySchema = z.object({
  amountMinor: z.number().int(),
  currency: currencyCodeSchema,
});

/** Same shape for requests, but rejects unknown keys so typos are not silently dropped. */
export const moneyInputSchema = z.strictObject({
  amountMinor: z.number().int(),
  currency: currencyCodeSchema,
});

/** Strictly positive amount (> 0). */
export const positiveMoneySchema = moneyInputSchema.refine((m) => m.amountMinor > 0, {
  message: "Amount must be positive",
  path: ["amountMinor"],
});

/** Non-zero amount; the sign is meaningful (balance adjustments, adjustments). */
export const nonZeroMoneySchema = moneyInputSchema.refine((m) => m.amountMinor !== 0, {
  message: "Amount must not be zero",
  path: ["amountMinor"],
});

export type CurrencyCode = z.output<typeof currencyCodeSchema>;
export type Money = z.output<typeof moneySchema>;
