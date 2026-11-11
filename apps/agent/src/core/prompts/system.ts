import systemPrompt from "./system.md" with { type: "text" };

/** Static on purpose: the same bytes on every call keep the provider's prompt cache warm. */
export const SYSTEM_PROMPT: string = systemPrompt.trim();
