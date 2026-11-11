import type { Account } from "@mpf/finance-contract";

import type { ChannelAdapter, InboundEvent, RichPart, RichText } from "../channels/channel";
import { errorFields, type Logger } from "../log";
import type { FinanceClients } from "./finance";
import { isFinanceError } from "./finance";
import { redeemLink, resolveUser, type ResolvedUser } from "./identity";
import { texts } from "./messages";
import { formatMoney } from "./money";
import type { EventHandler } from "./pipeline";
import { SessionRecorder } from "./session";

export interface HandlerOptions {
  adapter: ChannelAdapter;
  clients: FinanceClients;
  logger: Logger;
  sessionIdleMinutes: number;
}

export function formatBalances(accounts: Account[]): RichText {
  const active = accounts.filter((account) => !account.archived);
  if (active.length === 0) return texts.noAccounts();
  const parts: RichPart[] = [{ bold: "Balances" }, "\n"];
  const totals = new Map<string, number>();
  for (const account of active) {
    const { amountMinor, currency } = account.balance;
    parts.push(`${account.name}: `, { code: formatMoney(amountMinor, currency) }, "\n");
    totals.set(currency, (totals.get(currency) ?? 0) + amountMinor);
  }
  if (active.length > 1) {
    parts.push("\n");
    for (const [currency, total] of totals) parts.push({ bold: "Total: " }, { code: formatMoney(total, currency) }, "\n");
  }
  const last = parts[parts.length - 1];
  if (last === "\n") parts.pop();
  return parts;
}

/** Finance API errors the user can act on get a reply; anything else fails the event. */
function replyForFinanceError(error: unknown): RichText | null {
  if (isFinanceError(error, "unauthorized")) return texts.linkRevoked();
  if (isFinanceError(error, "forbidden")) return texts.notAllowed();
  if (isFinanceError(error, "rate_limited")) return texts.rateLimited();
  if (isFinanceError(error, "not_found", "conflict")) return texts.unavailable();
  return null;
}

/**
 * Which events get claimed (and their payload stored) at all. Group chats only
 * get a "use a private chat" answer to commands; their other messages, which
 * can be other members' text, are never stored.
 */
export function acceptEvent(event: InboundEvent): boolean {
  return event.chatType === "private" || event.kind === "command" || event.kind === "button";
}

export function createHandler(options: HandlerOptions): {
  handle: EventHandler;
  onFailure: (event: InboundEvent) => Promise<void>;
  accept: (event: InboundEvent) => boolean;
} {
  const { adapter, clients } = options;

  const reply = (event: InboundEvent, text: RichText) => adapter.send({ chatId: event.chatId }, { type: "text", text });

  /** Commands for a linked user. `record: false` for commands that delete the history they'd be stored in. */
  async function linkedCommand(event: InboundEvent, user: ResolvedUser, log: Logger): Promise<void> {
    const command = event.kind === "command" ? event.command : undefined;

    if (command === "unlink") {
      try {
        await clients.service.channelIdentities.unlink({ channel: event.channel, externalUserId: event.externalUserId });
      } catch (error) {
        if (!isFinanceError(error, "not_found")) throw error;
      }
      log.info("identity_unlinked");
      await reply(event, texts.unlinked());
      return;
    }

    if (command === "forget") {
      await user.finance.agentHistory.delete();
      log.info("history_deleted");
      await reply(event, texts.forgotten());
      return;
    }

    const recorder = new SessionRecorder(user.finance, event, options.sessionIdleMinutes, log);
    await recorder.recordUser();

    let answer: RichText;
    switch (command) {
      case "start":
        answer = texts.welcomeBack(user.displayName);
        break;
      case "help":
        answer = texts.help();
        break;
      case "balance": {
        await adapter.send({ chatId: event.chatId }, { type: "typing" }).catch(() => {});
        const { items } = await user.finance.accounts.list({});
        answer = formatBalances(items);
        break;
      }
      case undefined:
        answer = texts.comingSoon();
        break;
      default:
        answer = texts.unknownCommand();
    }

    await reply(event, answer);
    await recorder.recordAssistant(answer);
  }

  /**
   * Service-key calls: `rate_limited` gets its own reply (returns null). Other
   * errors (a bad service key is `unauthorized`) fail the event: they are ours, not the user's.
   */
  async function withServiceErrors<T>(event: InboundEvent, log: Logger, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      if (!isFinanceError(error, "rate_limited")) throw error;
      log.warn("finance_error", errorFields(error));
      await reply(event, texts.rateLimited());
      return null;
    }
  }

  async function handle(event: InboundEvent): Promise<void> {
    const log = options.logger.child({ eventId: event.eventId, chatId: event.chatId, kind: event.kind });

    if (event.kind === "button") {
      // Pending actions are executed in a later release; just stop the spinner.
      if (event.buttonId) await adapter.answerButton(event.buttonId, texts.buttonUnavailable());
      return;
    }

    if (event.chatType !== "private") {
      // Never resolve or link from a group: the user's data must not show up there.
      if (event.kind === "command") await reply(event, texts.privateOnly());
      return;
    }

    const code = event.command === "start" ? event.args?.[0] : undefined;
    if (event.kind === "command" && code) {
      const result = await withServiceErrors(event, log, () => redeemLink(clients, event, code));
      if (!result) return;
      log.info("link_redeem", { result });
      await reply(event, result === "linked" ? texts.linked() : result === "invalid" ? texts.linkInvalid() : texts.alreadyLinked());
      return;
    }

    const resolved = await withServiceErrors(event, log, async () => ({ user: await resolveUser(clients, event) }));
    if (!resolved) return;
    const user = resolved.user;
    if (!user) {
      log.info("chat_unlinked");
      const answer =
        event.command === "start" ? texts.welcomeUnlinked() : event.command === "help" ? texts.helpUnlinked() : texts.notLinked();
      await reply(event, answer);
      return;
    }

    try {
      await linkedCommand(event, user, log);
    } catch (error) {
      const answer = replyForFinanceError(error);
      if (!answer) throw error;
      log.warn("finance_error", errorFields(error));
      await reply(event, answer);
    }
  }

  async function onFailure(event: InboundEvent): Promise<void> {
    if (event.kind === "button") {
      if (event.buttonId) await adapter.answerButton(event.buttonId, texts.buttonUnavailable());
      return;
    }
    if (event.chatType !== "private") return;
    await reply(event, texts.failed());
  }

  return { handle, onFailure, accept: acceptEvent };
}
