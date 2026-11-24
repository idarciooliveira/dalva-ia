/** Schemas for what the agent stores as is: JSON text, bounded JSON values, platform ids. */
import { z } from "zod";

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;
const MAX_JSON_DEPTH = 12;

/** A string holding valid JSON, at most `maxBytes` of UTF-8. */
export const jsonString = (maxBytes: number) =>
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

function withinJsonDepth(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (typeof value !== "object" || value === null) return true;
  return Object.values(value).every((item) => withinJsonDepth(item, depth + 1));
}

/** A JSON value that serializes to at most `maxBytes` and nests at most 12 levels. */
export const boundedJson = <T extends z.ZodType>(schema: T, maxBytes: number) =>
  schema
    .refine((value) => utf8Bytes(JSON.stringify(value) ?? "") <= maxBytes, `Must serialize to at most ${maxBytes} bytes`)
    .refine(withinJsonDepth, `Nesting must be at most ${MAX_JSON_DEPTH} levels`);

/** Platform ids (Telegram user/chat ids are integers; chats can be negative). Kept as strings. */
export const externalIdSchema = z.string().regex(/^-?[A-Za-z0-9_]{1,64}$/, "Invalid external id");
