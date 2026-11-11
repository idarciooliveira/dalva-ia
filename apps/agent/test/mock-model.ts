import { MockLanguageModelV4 } from "ai/test";

type Json = Record<string, unknown>;

/** One model response: plain text, or one or more tool calls. */
export type MockStep = { text: string } | { tools: Array<{ name: string; input: Json }> } | { error: Error };

export const mockUsage = (input = 100, output = 20) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

/**
 * A model that answers each call with the next scripted step (the last step
 * repeats). `doGenerateCalls` keeps every prompt it received.
 */
export function scriptedModel(steps: MockStep[], options: { delayMs?: number } = {}) {
  let call = 0;
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-model",
    doGenerate: async ({ abortSignal, toolChoice }) => {
      let step = steps[Math.min(call, steps.length - 1)]!;
      // Like a real provider: with tool choice "none" the model has to answer in text.
      if (toolChoice?.type === "none" && "tools" in step) step = { text: "forced answer" };
      call += 1;
      if (options.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs);
          abortSignal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(abortSignal.reason ?? new Error("aborted"));
          });
        });
      }
      if ("error" in step) throw step.error;
      if ("text" in step) {
        return {
          content: [{ type: "text", text: step.text }],
          finishReason: { unified: "stop", raw: undefined },
          usage: mockUsage(),
          warnings: [],
        };
      }
      return {
        content: step.tools.map((tool, index) => ({
          type: "tool-call" as const,
          toolCallId: `call_${call}_${index}`,
          toolName: tool.name,
          input: JSON.stringify(tool.input),
        })),
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: mockUsage(),
        warnings: [],
      };
    },
  });
}
