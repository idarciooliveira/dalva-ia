/** Shared zod primitives for procedure inputs and outputs. Optional fields are omitted, never null. */
import { currencyCodeSchema, isoDateSchema, monthSchema } from "@mpf/shared";
import { z } from "zod";

import { isUuid } from "../db/ids";

export { currencyCodeSchema, isoDateSchema, monthSchema };

/** A row id: a canonical lowercase UUID. Anything else is `validation_failed` before it reaches a query. */
export const idSchema = z.string().refine(isUuid, "Invalid id");

/** Response dates are plain strings so one legacy row can't fail a whole list. Requests use `isoDateSchema`. */
export const responseDate = z.string();

/**
 * Integer ISO minor units in a currency (JPY 0 decimals, USD 2, KWD 3).
 * Responses tolerate extra keys so fields can be added later.
 */
export const moneySchema = z.object({ amountMinor: z.number().int(), currency: currencyCodeSchema });
/** Requests reject unknown keys, so typos are not silently dropped. */
export const moneyInputSchema = z.strictObject({ amountMinor: z.number().int(), currency: currencyCodeSchema });
export const positiveMoneySchema = moneyInputSchema.refine((m) => m.amountMinor > 0, {
  message: "Amount must be positive",
  path: ["amountMinor"],
});
/** The sign is meaningful (balance adjustments, adjustments). */
export const nonZeroMoneySchema = moneyInputSchema.refine((m) => m.amountMinor !== 0, {
  message: "Amount must not be zero",
  path: ["amountMinor"],
});
export const nonNegativeMoneySchema = moneyInputSchema.refine((m) => m.amountMinor >= 0, {
  message: "Must not be negative",
  path: ["amountMinor"],
});

export const shortText = (max: number) => z.string().min(1).max(max);
export const descriptionField = shortText(500);
export const noteField = shortText(1000);
export const payeeField = shortText(200);
/** Names are trimmed; blank is `validation_failed`. */
export const nameField = z.string().trim().min(1).max(100);
/** Lucide icon name or color (hex, e.g. "#9FE870"), as chosen in the app. Trimmed, non-blank. */
export const styleField = z.string().trim().min(1).max(64);

export const list = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });
export const deleted = z.object({ id: z.string() });
export const byId = z.strictObject({ id: idSchema });
export const includeArchived = z.strictObject({ includeArchived: z.boolean().optional() }).prefault({});

/** For updates: at least one field besides `id`. */
export const hasChangesBesidesId = (value: Record<string, unknown>) =>
  Object.entries(value).some(([key, v]) => key !== "id" && v !== undefined);
export const NO_CHANGES = "Provide at least one field to change";

/** Inputs with no fields: `.query()` / `.mutate()` without an argument. */
export const noInput = z.strictObject({}).prefault({});
