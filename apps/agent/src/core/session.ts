import { AGENT_APPEND_MAX_MESSAGES, AGENT_SESSION_MAX_MESSAGES, type AgentMessage, type AgentSession } from "@mpf/finance-contract";

import type { InboundEvent, RichText } from "../channels/channel";
import { errorFields, type Logger } from "../log";
import type { FinanceClient } from "./finance";
import { isFinanceError } from "./finance";
import { encodeAssistantText, HISTORY_FORMAT_VERSION, type StoredMessage } from "./history";

export function plainText(text: RichText): string {
  if (typeof text === "string") return text;
  return text.map((part) => (typeof part === "string" ? part : Object.values(part)[0])).join("");
}

/** What we store for an inbound message. `/start` args are dropped: they can hold a link code. */
export function userMessageContent(event: InboundEvent): string {
  const keepArgs = event.kind === "command" && event.command !== "start";
  return JSON.stringify({
    v: HISTORY_FORMAT_VERSION,
    kind: event.kind,
    ...(event.kind === "command" ? { command: event.command } : {}),
    ...(keepArgs && event.args?.length ? { args: event.args } : {}),
    ...(event.kind !== "command" && event.text !== undefined ? { text: event.text } : {}),
  });
}

/**
 * Records a conversation in the agent store (`sessions.current` +
 * `messages.append`) and reads it back for the agent. Recording is best
 * effort: a failure is logged and never blocks the reply.
 */
export class SessionRecorder {
  private current: AgentSession | null = null;

  constructor(
    private readonly finance: FinanceClient,
    private readonly event: InboundEvent,
    private readonly idleTimeoutMinutes: number,
    private readonly logger: Logger,
  ) {}

  async recordUser(): Promise<void> {
    await this.append("user", userMessageContent(this.event));
  }

  async recordAssistant(text: RichText): Promise<void> {
    await this.recordAll([encodeAssistantText(plainText(text))]);
  }

  /**
   * The latest `limit` messages of the chat's current session, oldest first.
   * Throws on API errors: the agent can't answer without its context.
   */
  async history(limit: number): Promise<AgentMessage[]> {
    const session = await this.session();
    if (session.messageCount === 0) return [];
    const { items } = await this.finance.agentMessages.list({ sessionId: session.id, limit });
    return items;
  }

  /**
   * Append one turn in order. A turn that would overflow the session starts a
   * new one first, so a turn is never split; a `conflict` (session ended or
   * full meanwhile) retries the remainder once in a fresh session.
   */
  async recordAll(messages: StoredMessage[]): Promise<void> {
    if (messages.length === 0) return;
    try {
      let session = await this.session();
      if (session.messageCount + messages.length > AGENT_SESSION_MAX_MESSAGES) session = await this.session(true);
      let retried = false;
      for (let start = 0; start < messages.length; ) {
        const batch = messages.slice(start, start + AGENT_APPEND_MAX_MESSAGES);
        try {
          await this.finance.agentMessages.append({ sessionId: session.id, messages: batch });
        } catch (error) {
          if (retried || !isFinanceError(error, "conflict", "not_found")) throw error;
          retried = true;
          session = await this.session(true);
          continue;
        }
        session.messageCount += batch.length;
        start += batch.length;
      }
    } catch (error) {
      this.logger.warn("session_record_failed", { ...errorFields(error), count: messages.length });
    }
  }

  private async session(startNew = false): Promise<AgentSession> {
    if (this.current && !startNew) return this.current;
    const { session } = await this.finance.agentSessions.current({
      channel: this.event.channel,
      chatId: this.event.chatId,
      idleTimeoutMinutes: this.idleTimeoutMinutes,
      ...(startNew ? { startNew: true } : {}),
    });
    this.current = { ...session };
    return this.current;
  }

  private async append(role: "user" | "assistant", content: string): Promise<void> {
    await this.recordAll([{ role, content }]);
  }
}
