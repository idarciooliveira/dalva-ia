import { generateText, isStepCount, type LanguageModel, type ModelMessage } from "ai";

import { cachedSystemMessage, withCacheBreakpoint } from "../llm/model";
import { errorFields, type Logger } from "../log";
import { createReadTools } from "../tools";
import type { FinanceClient } from "./finance";
import { decodeHistory, encodeAssistantText, encodeResponseMessages, encodeUserText, trimHistory } from "./history";
import { SYSTEM_PROMPT } from "./prompts/system";
import type { SessionRecorder } from "./session";

export interface AgentOptions {
  model: LanguageModel;
  /** Model calls per turn (tool round-trips + the answer). The last one can't call tools. */
  maxSteps: number;
  maxOutputTokens?: number;
  /** Whole turn, history load and tool calls included. */
  turnTimeoutMs: number;
  /** IANA zone used for "today" in the context block and for default report months. */
  timezone: string;
  logger: Logger;
  /** Stored messages replayed to the model. Default 30. */
  historyLimit?: number;
  /** Serialized size budget for replayed history (oldest turns go first). Default 24 KB. */
  historyMaxBytes?: number;
  /** Aborts every running turn (shutdown). */
  stopSignal?: AbortSignal;
  now?: () => Date;
}

export interface UserContext {
  displayName?: string;
  baseCurrency?: string;
}

export interface AgentTurnInput {
  text: string;
  session: SessionRecorder;
  userContext: UserContext;
  /** Client bound to the user's token. Tools use it; the model never sees the token. */
  finance: FinanceClient;
  /** Shows the typing indicator; called repeatedly while the turn runs. */
  typing?: () => Promise<void>;
}

export interface AgentTurnResult {
  text: string;
  steps: number;
  toolCalls: Array<{ name: string; input: unknown }>;
  usage: { inputTokens: number; outputTokens: number };
}

export interface Agent {
  runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
}

const DEFAULT_HISTORY_LIMIT = 30;
const DEFAULT_HISTORY_MAX_BYTES = 24 * 1024;
/** Telegram shows "typing…" for about 5 seconds per call. */
const TYPING_INTERVAL_MS = 4_500;
const FALLBACK_REPLY = "Sorry, I couldn't put an answer together. Please try asking in another way.";

/** `YYYY-MM-DD` and weekday of `date` in `timeZone`. */
export function localDay(date: Date, timeZone: string): { date: string; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(date);
  return { date: parts, weekday };
}

/** One line of profile text, safe to put in the context block. */
const oneLine = (text: string, max: number) =>
  text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[[\]]/g, "")
    .trim()
    .slice(0, max);

/**
 * Per-turn facts, sent at the start of the user message (not in the system
 * prompt, which stays byte-identical across turns for prompt caching).
 */
export function contextBlock(day: { date: string; weekday: string }, timeZone: string, user: UserContext): string {
  const lines = [`Today: ${day.date} (${day.weekday}), time zone ${timeZone}`];
  if (user.baseCurrency) lines.push(`Base currency: ${oneLine(user.baseCurrency, 3)}`);
  if (user.displayName) lines.push(`Name: ${oneLine(user.displayName, 60)}`);
  return `[DALVA context]\n${lines.join("\n")}\n[/DALVA context]`;
}

/** The adapter escapes everything, so Markdown would show up literally: strip what models add anyway. */
export function toPlainText(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/`/g, "")
    .trim();
}

function startTyping(typing: (() => Promise<void>) | undefined): () => void {
  if (!typing) return () => {};
  const send = () => void typing().catch(() => {});
  send();
  const timer = setInterval(send, TYPING_INTERVAL_MS);
  return () => clearInterval(timer);
}

const modelName = (model: LanguageModel) => (typeof model === "string" ? model : model.modelId);
const providerName = (model: LanguageModel) => (typeof model === "string" ? "gateway" : model.provider);

export function createAgent(options: AgentOptions): Agent {
  const { model, logger, timezone } = options;
  const now = options.now ?? (() => new Date());
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const historyMaxBytes = options.historyMaxBytes ?? DEFAULT_HISTORY_MAX_BYTES;
  const maxSteps = Math.max(1, options.maxSteps);
  const instructions = cachedSystemMessage(SYSTEM_PROMPT);

  async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const started = Date.now();
    const stopTyping = startTyping(input.typing);
    const deadline = AbortSignal.timeout(options.turnTimeoutMs);
    const abort = new AbortController();
    // One signal for everything the turn does: history load, model calls and tool API calls.
    const signal = AbortSignal.any([abort.signal, deadline, ...(options.stopSignal ? [options.stopSignal] : [])]);
    /** First error that must end the turn (revoked link, rate limit). */
    let fatal: unknown;

    try {
      const day = localDay(now(), timezone);
      const history = trimHistory(decodeHistory(await input.session.history(historyLimit, signal)), historyMaxBytes);
      if (history.length) history[history.length - 1] = withCacheBreakpoint(history[history.length - 1]!);
      const tools = createReadTools({
        finance: input.finance,
        today: day.date,
        signal,
        onFatal: (error) => {
          fatal ??= error;
          abort.abort(error);
        },
      });
      const userMessage: ModelMessage = {
        role: "user",
        content: `${contextBlock(day, timezone, input.userContext)}\n\n${input.text}`,
      };

      const result = await generateText({
        model,
        instructions,
        messages: [...history, userMessage],
        tools,
        stopWhen: isStepCount(maxSteps),
        // The last allowed step must answer, not call another tool.
        prepareStep: ({ stepNumber }) => (stepNumber >= maxSteps - 1 ? { toolChoice: "none" as const } : {}),
        ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
        maxRetries: 1,
        abortSignal: signal,
      });
      if (fatal) throw fatal;

      const modelText = toPlainText(result.text);
      const text = modelText || FALLBACK_REPLY;
      const toolCalls = result.steps.flatMap((step) => step.toolCalls.map((call) => ({ name: call.toolName, input: call.input })));
      const usage = { inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 };

      logger.info("agent_turn", {
        provider: providerName(model),
        model: modelName(model),
        steps: result.steps.length,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: result.usage.inputTokenDetails?.cacheReadTokens,
        finishReason: result.finishReason,
        tools: toolCalls.map((call) => call.name).join(",") || undefined,
        historyMessages: history.length,
        ms: Date.now() - started,
      });

      await input.session.recordAll([
        encodeUserText(input.text),
        ...encodeResponseMessages(result.responseMessages),
        ...(modelText ? [] : [encodeAssistantText(text)]),
      ]);

      return { text, steps: result.steps.length, toolCalls, usage };
    } catch (error) {
      const cause = fatal ?? error;
      logger.warn("agent_turn_failed", {
        ...errorFields(cause),
        provider: providerName(model),
        model: modelName(model),
        timedOut: deadline.aborted,
        stopped: options.stopSignal?.aborted || undefined,
        ms: Date.now() - started,
      });
      throw cause;
    } finally {
      stopTyping();
    }
  }

  return { runAgentTurn };
}
