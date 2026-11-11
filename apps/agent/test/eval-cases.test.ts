import { describe, expect, test } from "vitest";

import { cases, matches } from "../eval/cases";
import { READ_TOOL_NAMES } from "../src/tools";

describe("eval cases", () => {
  test("about 20 cases, every expected tool exists", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    const names = new Set<string>(READ_TOOL_NAMES);
    for (const testCase of cases) for (const requirement of testCase.expect) for (const alt of requirement) expect(names.has(alt.tool)).toBe(true);
  });

  test("matches on tool name and key arguments (values or predicates)", () => {
    const [requirement] = cases[2]!.expect; // "mostra as últimas 5 despesas"
    expect(requirement!.some((alt) => matches(alt, { name: "search_transactions", input: { type: "expense", limit: 5 } }))).toBe(true);
    expect(requirement!.some((alt) => matches(alt, { name: "search_transactions", input: { type: "expense" } }))).toBe(false);
    const [month] = cases[0]!.expect;
    expect(month!.some((alt) => matches(alt, { name: "get_spending_by_category", input: {} }))).toBe(true);
    expect(month!.some((alt) => matches(alt, { name: "get_spending_by_category", input: { month: "2026-10" } }))).toBe(false);
  });
});
