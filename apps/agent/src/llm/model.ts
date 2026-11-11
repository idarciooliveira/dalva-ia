import { createGateway } from "@ai-sdk/gateway";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel, ModelMessage, SystemModelMessage } from "ai";

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
 * Prompt-cache breakpoint. Both providers forward `anthropic.cacheControl`
 * to Anthropic models; other vendors ignore it (and cache stable prefixes on their own).
 */
const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" as const } } };

/** The system prompt as a message with a cache breakpoint. */
export function cachedSystemMessage(content: string): SystemModelMessage {
  return { role: "system", content, providerOptions: CACHE_BREAKPOINT };
}

/** The same breakpoint at the end of the replayed history, so earlier turns are read from cache too. */
export function withCacheBreakpoint<T extends ModelMessage>(message: T): T {
  return { ...message, providerOptions: { ...message.providerOptions, ...CACHE_BREAKPOINT } };
}
