import { AGENT_MESSAGE_CONTENT_MAX_BYTES, type AgentMessage } from "@mpf/finance-contract";
import type { ModelMessage, ToolResultPart } from "ai";

/**
 * Stored conversation format. Provider-agnostic on purpose: only plain text,
 * tool calls and JSON tool results are kept (no provider metadata, no
 * reasoning), so a history written with one provider replays on any other.
 *
 * v1 (`content` of an agent-store message, JSON):
 * - user:      `{ v, kind: "text", text }` or `{ v, kind: "command", command, args? }` (also `photo`)
 * - assistant: `{ v, text?, toolCalls?: [{ id, name, input }] }`
 * - tool:      `{ v, toolResults: [{ id, name, output, isError? }] }`
 *
 * Records written before versioning (no `v`) have the same shapes and load as v1.
 * Records with a newer `v` are skipped.
 */
export const HISTORY_FORMAT_VERSION = 1;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface StoredToolCall {
  id: string;
  name: string;
  input: Json;
}
export interface StoredToolResult {
  id: string;
  name: string;
  output: Json;
  isError?: boolean;
}

export type StoredMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool"; content: string };

const v = HISTORY_FORMAT_VERSION;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

export const encodeUserText = (text: string): StoredMessage => ({
  role: "user",
  content: JSON.stringify({ v, kind: "text", text }),
});

/** Longest assistant text kept per record; replies are short, this only guards runaway output. */
const ASSISTANT_TEXT_MAX = 8_000;

export const encodeAssistantText = (text: string): StoredMessage => ({
  role: "assistant",
  content: JSON.stringify({ v, text: text.slice(0, ASSISTANT_TEXT_MAX) }),
});

/** JSON-safe copy (drops undefined, functions...). */
const toJson = (value: unknown): Json => (value === undefined ? null : (JSON.parse(JSON.stringify(value)) as Json));

const TOO_LARGE: Json = { error: "too_large", message: "Result was too large to keep." };

/** Results too large for one stored message are replaced by a marker, largest first, until the record fits. */
function fitToolResults(results: StoredToolResult[]): string {
  const fitted = results.map((result) => ({ ...result }));
  const content = () => JSON.stringify({ v, toolResults: fitted });
  const bySize = fitted
    .map((result, index) => ({ index, size: utf8Bytes(JSON.stringify(result.output)) }))
    .sort((a, b) => b.size - a.size);
  for (const { index } of bySize) {
    if (utf8Bytes(content()) <= AGENT_MESSAGE_CONTENT_MAX_BYTES) break;
    fitted[index] = { ...fitted[index]!, output: TOO_LARGE, isError: true };
  }
  return content();
}

/** Tool-call inputs come from the model (even invalid ones): keep a bounded copy. */
const TOOL_INPUT_MAX_BYTES = 2_000;
const boundedInput = (input: unknown): Json => {
  const json = toJson(input);
  return utf8Bytes(JSON.stringify(json)) <= TOOL_INPUT_MAX_BYTES ? json : { too_large: true };
};

/** AI SDK response messages (assistant + tool) -> stored records. */
export function encodeResponseMessages(messages: ModelMessage[]): StoredMessage[] {
  const stored: StoredMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const parts = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
      const text = parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const toolCalls: StoredToolCall[] = parts
        .filter((part) => part.type === "tool-call")
        .map((part) => ({ id: part.toolCallId, name: part.toolName.slice(0, 64), input: boundedInput(part.input) }));
      if (!text && toolCalls.length === 0) continue;
      stored.push({
        role: "assistant",
        content: JSON.stringify({ v, ...(text ? { text: text.slice(0, ASSISTANT_TEXT_MAX) } : {}), ...(toolCalls.length ? { toolCalls } : {}) }),
      });
    } else if (message.role === "tool") {
      const results: StoredToolResult[] = message.content
        .filter((part): part is ToolResultPart => part.type === "tool-result")
        .map((part) => {
          const { output } = part;
          const isError = output.type === "error-json" || output.type === "error-text";
          const value = "value" in output ? toJson(output.value) : null;
          return { id: part.toolCallId, name: part.toolName, output: value, ...(isError ? { isError } : {}) };
        });
      if (results.length) stored.push({ role: "tool", content: fitToolResults(results) });
    }
  }
  return stored;
}

function parse(message: Pick<AgentMessage, "content">): Record<string, any> | null {
  try {
    const value: unknown = JSON.parse(message.content);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const version = (value as { v?: unknown }).v;
    if (version !== undefined && version !== HISTORY_FORMAT_VERSION) return null;
    return value as Record<string, any>;
  } catch {
    return null;
  }
}

const isString = (value: unknown): value is string => typeof value === "string";

function decodeUser(record: Record<string, any>): ModelMessage | null {
  if (record.kind === "command" && isString(record.command)) {
    const args = Array.isArray(record.args) ? record.args.filter(isString) : [];
    return { role: "user", content: ["/" + record.command, ...args].join(" ") };
  }
  if (record.kind === "photo") return { role: "user", content: `[photo]${isString(record.text) ? ` ${record.text}` : ""}` };
  if (isString(record.text) && record.text) return { role: "user", content: record.text };
  return null;
}

/**
 * Stored records (oldest first) -> model messages. Drops what a provider
 * would reject: leading non-user messages (the window can start mid-turn),
 * tool calls without their results and results without their calls.
 */
export function decodeHistory(records: Array<Pick<AgentMessage, "role" | "content">>): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const value = parse(record);
    if (!value) continue;

    if (record.role === "user") {
      const message = decodeUser(value);
      if (message) out.push(message);
      continue;
    }
    if (out.length === 0) continue; // history must start with the user

    if (record.role === "assistant") {
      const text = isString(value.text) ? value.text : "";
      const calls: StoredToolCall[] = Array.isArray(value.toolCalls)
        ? value.toolCalls.filter((c: any) => isString(c?.id) && isString(c?.name))
        : [];
      // Calls are kept only when the next record answers every one of them.
      const next = records[i + 1];
      const nextValue = next?.role === "tool" ? parse(next) : null;
      const results: StoredToolResult[] = Array.isArray(nextValue?.toolResults)
        ? nextValue!.toolResults.filter((r: any) => isString(r?.id) && isString(r?.name))
        : [];
      const answered = calls.length > 0 && calls.every((call) => results.some((r) => r.id === call.id));
      if (answered) {
        out.push({
          role: "assistant",
          content: [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...calls.map((call) => ({ type: "tool-call" as const, toolCallId: call.id, toolName: call.name, input: call.input ?? {} })),
          ],
        });
        out.push({
          role: "tool",
          content: calls.map((call) => {
            const result = results.find((r) => r.id === call.id)!;
            return {
              type: "tool-result" as const,
              toolCallId: call.id,
              toolName: call.name,
              output: result.isError ? { type: "error-json" as const, value: result.output ?? null } : { type: "json" as const, value: result.output ?? null },
            };
          }),
        });
        i += 1; // the tool record is consumed
      } else if (text) {
        out.push({ role: "assistant", content: text });
      }
      continue;
    }
    // `tool` records not consumed above are orphans; `system` records are never replayed.
  }
  return out;
}

/**
 * Keep the newest messages within `maxBytes` of serialized JSON, cutting only
 * at user messages so a turn's tool calls and results stay together. The
 * newest turn is always kept.
 */
export function trimHistory(messages: ModelMessage[], maxBytes: number): ModelMessage[] {
  let total = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    total += utf8Bytes(JSON.stringify(messages[i]));
    if (messages[i]!.role !== "user") continue;
    if (total > maxBytes && start < messages.length) break;
    start = i;
  }
  return messages.slice(start);
}
