/** Shared zod primitives for procedure inputs and outputs. Optional fields are omitted, never null. */
import { z } from "zod";

import { isUuid } from "../db/ids";

/** A row id: a canonical lowercase UUID. Anything else is `validation_failed` before it reaches a query. */
export const idSchema = z.string().refine(isUuid, "Invalid id");

export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "Expected ISO 4217 code, e.g. USD");

/** Integer ISO minor units in a currency (JPY 0 decimals, USD 2, KWD 3). Responses tolerate extra keys. */
export const moneySchema = z.object({ amountMinor: z.number().int(), currency: currencyCodeSchema });
/** Requests reject unknown keys, so typos are not silently dropped. */
export const moneyInputSchema = z.strictObject({ amountMinor: z.number().int(), currency: currencyCodeSchema });
export const nonZeroMoneySchema = moneyInputSchema.refine((m) => m.amountMinor !== 0, {
  message: "Amount must not be zero",
  path: ["amountMinor"],
});

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Calendar date, `YYYY-MM-DD`, checked against the real calendar. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number) as [number, number, number];
    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
  }, "Not a real calendar date");

export const shortText = (max: number) => z.string().min(1).max(max);

/** For updates: at least one field besides `id`. */
export const hasChangesBesidesId = (value: Record<string, unknown>) =>
  Object.entries(value).some(([key, v]) => key !== "id" && v !== undefined);
export const NO_CHANGES = "Provide at least one field to change";
