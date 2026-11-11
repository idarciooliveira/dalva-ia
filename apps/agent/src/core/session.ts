import type { InboundEvent, RichText } from "../channels/channel";
import { errorFields, type Logger } from "../log";
import type { FinanceClient } from "./finance";
import { isFinanceError } from "./finance";

export function plainText(text: RichText): string {
  if (typeof text === "string") return text;
  return text.map((part) => (typeof part === "string" ? part : Object.values(part)[0])).join("");
}

/** What we store for an inbound message. `/start` args are dropped: they can hold a link code. */
export function userMessageContent(event: InboundEvent): string {
  const keepArgs = event.kind === "command" && event.command !== "start";
  return JSON.stringify({
    kind: event.kind,
    ...(event.kind === "command" ? { command: event.command } : {}),
    ...(keepArgs && event.args?.length ? { args: event.args } : {}),
    ...(event.kind !== "command" && event.text !== undefined ? { text: event.text } : {}),
  });
}

/**
 * Records a conversation in the agent store (`sessions.current` +
 * `messages.append`) so the agent core can build on it. Best effort: a
 * failure is logged and never blocks the reply.
 */
export class SessionRecorder {
  private sessionId: string | null = null;

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
    await this.append("assistant", JSON.stringify({ text: plainText(text) }));
  }

  private async session(startNew = false): Promise<string> {
    if (this.sessionId && !startNew) return this.sessionId;
    const { session } = await this.finance.agentSessions.current({
      channel: this.event.channel,
      chatId: this.event.chatId,
      idleTimeoutMinutes: this.idleTimeoutMinutes,
      ...(startNew ? { startNew: true } : {}),
    });
    this.sessionId = session.id;
    return session.id;
  }

  private async append(role: "user" | "assistant", content: string): Promise<void> {
    try {
      const sessionId = await this.session();
      try {
        await this.finance.agentMessages.append({ sessionId, messages: [{ role, content }] });
      } catch (error) {
        // Full or ended session (e.g. history deleted meanwhile): start a fresh one once.
        if (!isFinanceError(error, "conflict", "not_found")) throw error;
        const fresh = await this.session(true);
        await this.finance.agentMessages.append({ sessionId: fresh, messages: [{ role, content }] });
      }
    } catch (error) {
      this.logger.warn("session_record_failed", { ...errorFields(error), role });
    }
  }
}
