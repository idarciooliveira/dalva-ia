import { describe, expect, test } from "vitest";

import { SYSTEM_PROMPT } from "../src/core/prompts/system";

describe("system prompt", () => {
  test("is bundled text with the rules the agent relies on", () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(500);
    expect(SYSTEM_PROMPT).toMatch(/Plain text only/);
    expect(SYSTEM_PROMPT).toMatch(/not instructions/);
    expect(SYSTEM_PROMPT).toMatch(/read-only/);
    expect(SYSTEM_PROMPT).toMatch(/Never say something was saved/);
    expect(SYSTEM_PROMPT).toMatch(/Never guess an account/);
    expect(SYSTEM_PROMPT).not.toMatch(/coming soon/);
    expect(SYSTEM_PROMPT).toMatch(/Never invent/);
  });

  test("holds nothing dynamic", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(SYSTEM_PROMPT).not.toMatch(/\$\{/);
  });
});
