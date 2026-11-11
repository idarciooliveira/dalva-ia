import type { ModelMessage } from "ai";
import { describe, expect, test } from "vitest";

import { decodeHistory, encodeResponseMessages, trimHistory } from "../src/core/history";

const call = (id: string, name: string, input: unknown = {}) => ({ type: "tool-call" as const, toolCallId: id, toolName: name, input });
const result = (id: string, name: string, value: unknown) => ({
  type: "tool-result" as const,
  toolCallId: id,
  toolName: name,
  output: { type: "json" as const, value: value as never },
});

describe("history format", () => {
  test("parallel calls, tool errors and text round-trip", () => {
    const response: ModelMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "Let me check." }, call("a", "list_accounts"), call("b", "list_goals", { includeArchived: true })] },
      {
        role: "tool",
        content: [
          result("a", "list_accounts", { accounts: [] }),
          { type: "tool-result", toolCallId: "b", toolName: "list_goals", output: { type: "error-json", value: { error: "not_found" } } },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ];
    const stored = encodeResponseMessages(response);
    const decoded = decodeHistory([{ role: "user", content: JSON.stringify({ v: 1, kind: "text", text: "hi" }) }, ...stored]);
    expect(decoded).toEqual([{ role: "user", content: "hi" }, ...response.slice(0, 1), response[1], { role: "assistant", content: "Done." }]);
  });

  test("a partially answered call is dropped, its text kept", () => {
    const stored = [
      { role: "user", content: JSON.stringify({ v: 1, kind: "text", text: "hi" }) },
      { role: "assistant", content: JSON.stringify({ v: 1, text: "Checking", toolCalls: [{ id: "a", name: "x", input: {} }, { id: "b", name: "y", input: {} }] }) },
      { role: "tool", content: JSON.stringify({ v: 1, toolResults: [{ id: "a", name: "x", output: 1 }] }) },
    ] as const;
    expect(decodeHistory([...stored])).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Checking" },
    ]);
  });

  test("oversized results are replaced largest first; the rest are kept", () => {
    const big = "x".repeat(40_000);
    const [, tool] = encodeResponseMessages([
      { role: "assistant", content: [call("a", "list_accounts"), call("b", "get_net_worth")] },
      { role: "tool", content: [result("a", "list_accounts", { big }), result("b", "get_net_worth", { netWorth: "1.00" })] },
    ]);
    const parsed = JSON.parse(tool!.content);
    expect(tool!.content.length).toBeLessThan(32 * 1024);
    expect(parsed.toolResults[0]).toMatchObject({ isError: true, output: { error: "too_large" } });
    expect(parsed.toolResults[1]).toEqual({ id: "b", name: "get_net_worth", output: { netWorth: "1.00" } });
  });

  test("runaway assistant text and tool inputs are bounded", () => {
    const [assistant] = encodeResponseMessages([
      { role: "assistant", content: [{ type: "text", text: "y".repeat(50_000) }, call("a", "search_transactions", { text: "z".repeat(10_000) })] },
    ]);
    const parsed = JSON.parse(assistant!.content);
    expect(assistant!.content.length).toBeLessThan(32 * 1024);
    expect(parsed.toolCalls[0].input).toEqual({ too_large: true });
  });

  test("trimHistory cuts at user messages and always keeps the newest turn", () => {
    const turn = (n: number): ModelMessage[] => [
      { role: "user", content: `q${n}` },
      { role: "assistant", content: [call(`c${n}`, "x")] },
      { role: "tool", content: [result(`c${n}`, "x", "r".repeat(1000))] },
      { role: "assistant", content: `a${n}` },
    ];
    const all = [...turn(1), ...turn(2), ...turn(3)];
    expect(trimHistory(all, 100)).toEqual(turn(3));
    expect(trimHistory(all, 2_600)).toEqual([...turn(2), ...turn(3)]);
    expect(trimHistory(all, 1_000_000)).toEqual(all);
    expect(trimHistory([], 10)).toEqual([]);
  });
});
