import { describe, expect, test, vi } from "vitest";

import { getModel } from "../src/llm/model";

describe("getModel", () => {
  test("gateway: AI Gateway model with the configured id, no network on creation", () => {
    const fetch = vi.fn();
    const model = getModel({ provider: "gateway", modelId: "anthropic/claude-sonnet-5-5", apiKey: "gw-key" }, { fetch });
    expect(typeof model).toBe("object");
    expect(model).toMatchObject({ modelId: "anthropic/claude-sonnet-5-5" });
    expect((model as { provider: string }).provider).toMatch(/^gateway/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("openrouter: OpenRouter model with the configured id, no network on creation", () => {
    const fetch = vi.fn();
    const model = getModel({ provider: "openrouter", modelId: "openai/gpt-5.5", apiKey: "or-key" }, { fetch });
    expect(model).toMatchObject({ modelId: "openai/gpt-5.5" });
    expect((model as { provider: string }).provider).toMatch(/^openrouter/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("the configured key is the one sent (never a key from elsewhere in the env)", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 500 }));
    const model = getModel({ provider: "openrouter", modelId: "openai/gpt-5.5", apiKey: "or-key-123" }, { fetch });
    await (model as any)
      .doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
      .catch(() => {});
    expect(fetch).toHaveBeenCalled();
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer or-key-123");
  });
});
