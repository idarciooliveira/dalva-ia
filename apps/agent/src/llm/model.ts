import { createGateway } from "@ai-sdk/gateway";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel, SystemModelMessage } from "ai";

/**
 * The only place that knows model providers. Everything else gets a
 * `LanguageModel` (the AI SDK's provider-neutral interface) from here.
 */

export type AiProvider = "gateway" | "openrouter";

export interface ModelSettings {
  provider: AiProvider;
  /** Provider-specific id, e.g. `anthropic/claude-sonnet-5-5` (both providers use `<vendor>/<model>`). */
  modelId: string;
  /** Key of the selected provider. Passed explicitly: providers never read it from the env themselves. */
  apiKey: string;
}

export interface ModelOptions {
  /** Custom fetch (tests). */
  fetch?: typeof fetch;
}

export function getModel(settings: ModelSettings, options: ModelOptions = {}): LanguageModel {
  switch (settings.provider) {
    case "gateway":
      return createGateway({ apiKey: settings.apiKey, ...(options.fetch ? { fetch: options.fetch } : {}) })(settings.modelId);
    case "openrouter":
      return createOpenRouter({
        apiKey: settings.apiKey,
        compatibility: "strict",
        appName: "DALVA",
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }).chat(settings.modelId);
  }
}

/**
 * The system prompt as a message with a prompt-cache breakpoint. Both
 * providers forward `anthropic.cacheControl` to Anthropic models; other
 * vendors ignore it (and cache stable prefixes on their own).
 */
export function cachedSystemMessage(content: string): SystemModelMessage {
  return { role: "system", content, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } };
}
