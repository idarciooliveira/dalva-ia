import { z } from "zod";

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

/** Calendar month, `YYYY-MM`. */
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM");

/** Three uppercase letters. Format-checked, not checked against the ISO registry. */
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "Expected ISO 4217 code, e.g. USD");

/** Single-use chat link code: 43 chars of base64url today, Telegram `start`-param safe. */
export const linkCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "Invalid link code");

/* Agent store limits: the API enforces them, the agent sizes what it sends. */

/** Largest stored inbound event payload, in UTF-8 bytes. */
export const AGENT_EVENT_PAYLOAD_MAX_BYTES = 32 * 1024;
/** Largest stored message `content`, in UTF-8 bytes. */
export const AGENT_MESSAGE_CONTENT_MAX_BYTES = 32 * 1024;
/** Largest pending-action `input` / `result`, as serialized JSON bytes. */
export const AGENT_ACTION_JSON_MAX_BYTES = 16 * 1024;
/** A session takes at most this many messages; past it `append` answers `conflict`. */
export const AGENT_SESSION_MAX_MESSAGES = 500;
export const AGENT_APPEND_MAX_MESSAGES = 20;
