import { FinanceApiError, formatMinorAmount, isoDateSchema, monthSchema as contractMonthSchema } from "@mpf/finance-contract";
import type { FinanceClient } from "@mpf/finance-contract";
import { z } from "zod";

/**
 * What a tool may use. The finance client already carries the user's
 * credentials, so nothing that identifies or authenticates the user is ever
 * part of a tool's input or output.
 */
export interface ToolContext {
  finance: FinanceClient;
  /** Today in the user's time zone, `YYYY-MM-DD`. */
  today: string;
  /** Called with errors that must end the turn (revoked link, rate limit). */
  onFatal: (error: unknown) => void;
  /** Aborted when the turn ends early (timeout, fatal error, shutdown): in-flight API calls stop too. */
  signal?: AbortSignal;
}

/** Call options for every Finance API call of a tool. */
export const call = (context: ToolContext) => ({ signal: context.signal });

/** Amount as the model sees it: an exact decimal string plus its currency. */
export interface Amount {
  amount: string;
  currency: string;
}

export interface ToolError {
  error: string;
  message: string;
}

export const money = (value: { amountMinor: number; currency: string }): Amount => ({
  amount: formatMinorAmount(value.amountMinor, value.currency),
  currency: value.currency,
});

/** Integer percent of `part` in `whole`, or null when `whole` is zero. */
export const percent = (part: number, whole: number): number | null => (whole === 0 ? null : Math.round((part / whole) * 100));

/** First `max` items, and whether anything was cut. */
export function bounded<T>(items: T[], max: number): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, max), truncated: items.length > max };
}

/** Free text from the user's data, cut so one row can't flood the context. */
export function clip(text: string, max?: number): string;
export function clip(text: string | undefined, max?: number): string | undefined;
export function clip(text: string | undefined, max = 120): string | undefined {
  return text === undefined ? undefined : text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Names are user-entered too; keep them short. */
export const NAME_MAX = 80;

/** Drop undefined fields so results stay compact. */
export function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export const currentMonth = (today: string) => today.slice(0, 7);

export const idInput = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const dateInput = isoDateSchema;
export const monthInput = contractMonthSchema.describe("Calendar month YYYY-MM. Defaults to the current month.");
export const includeArchivedInput = z.boolean().optional().describe("Include archived items. Default false.");

/** Errors that end the whole turn: the handler answers them (relink, wait). */
const FATAL_CODES = new Set(["unauthorized", "forbidden", "rate_limited"]);
const UNAVAILABLE_CODES = new Set(["network_error", "timeout", "aborted", "internal", "invalid_response"]);

function conflictDetails(error: FinanceApiError): { reason?: string; currencies?: string[] } {
  const details = error.details as { reason?: unknown; currencies?: unknown } | undefined;
  return {
    reason: typeof details?.reason === "string" ? details.reason : undefined,
    currencies: Array.isArray(details?.currencies) ? details.currencies.filter((c): c is string => typeof c === "string") : undefined,
  };
}

/** Finance API error -> a result the model can read and explain. Fixed wording: server messages never reach the model unfiltered. */
export function toToolError(error: unknown, context: Pick<ToolContext, "onFatal">): ToolError {
  if (!(error instanceof FinanceApiError)) return { error: "internal", message: "Unexpected error while reading the data." };
  if (FATAL_CODES.has(error.code)) {
    context.onFatal(error);
    return { error: error.code, message: "Access to the user's data was refused. Stop and do not retry." };
  }
  if (UNAVAILABLE_CODES.has(error.code)) {
    return { error: "unavailable", message: "The finance service is unavailable right now. Tell the user to try again in a moment." };
  }
  if (error.code === "conflict") {
    const { reason, currencies } = conflictDetails(error);
    if (reason === "mixed_currencies") {
      const list = currencies?.length ? ` (${currencies.join(", ")})` : "";
      return {
        error: "mixed_currencies",
        message: `This would add up amounts in more than one currency${list}, and reports across multiple currencies are not supported yet. Tell the user that plainly; per-account data (balances, transactions) still works.`,
      };
    }
    if (reason === "unknown_currency") {
      return {
        error: "unknown_currency",
        message: "Some rows belong to a deleted account, so their currency is unknown and this report can't be computed.",
      };
    }
    return { error: "conflict", message: "The request conflicts with the current data." };
  }
  if (error.code === "not_found") {
    return { error: "not_found", message: "Not found. The id may be wrong or the item was deleted; list again to get valid ids." };
  }
  if (error.code === "validation_failed") {
    return { error: "validation_failed", message: "Invalid input. Check ids (from the list tools), dates (YYYY-MM-DD) and months (YYYY-MM)." };
  }
  return { error: error.code, message: "The request failed." };
}

/** Run a tool body; Finance API errors become a `ToolError` result. */
export async function guarded<T>(context: ToolContext, run: () => Promise<T>): Promise<T | ToolError> {
  try {
    return await run();
  } catch (error) {
    return toToolError(error, context);
  }
}
