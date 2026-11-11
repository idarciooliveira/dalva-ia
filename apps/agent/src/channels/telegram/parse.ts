import type { Message, Update } from "grammy/types";

import type { ChatType, InboundEvent } from "../channel";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function chatTypeOf(type: string): ChatType {
  if (type === "private") return "private";
  if (type === "channel") return "channel";
  return "group"; // group, supergroup
}

/**
 * Split a leading `/command@bot arg1 arg2`. Returns null when the text is not
 * a command, or is a command addressed to another bot.
 */
function parseCommand(message: Message, botUsername: string): { command: string; args: string[] } | null {
  const text = message.text;
  const entity = message.entities?.[0];
  if (!text || !entity || entity.type !== "bot_command" || entity.offset !== 0) return null;
  const [name, mention] = text.slice(1, entity.length).split("@");
  if (!name) return null;
  if (mention && mention.toLowerCase() !== botUsername.toLowerCase()) return null;
  const args = text.slice(entity.length).trim().split(/\s+/).filter(Boolean);
  return { command: name.toLowerCase(), args };
}

/** Telegram `Update` -> `InboundEvent`. Anything the agent doesn't handle yet is null. */
export function parseTelegramUpdate(raw: unknown, botUsername: string): InboundEvent | null {
  if (!isObject(raw) || typeof raw.update_id !== "number") return null;
  const update = raw as unknown as Update;
  const eventId = String(update.update_id);

  if (update.callback_query) {
    const query = update.callback_query;
    const chat = query.message?.chat;
    if (!chat || query.from.is_bot || typeof query.data !== "string") return null;
    return {
      channel: "telegram",
      eventId,
      externalUserId: String(query.from.id),
      chatId: String(chat.id),
      chatType: chatTypeOf(chat.type),
      kind: "button",
      buttonPayload: query.data,
      buttonId: query.id,
      username: query.from.username,
    };
  }

  const message = update.message;
  if (!message || !message.from || message.from.is_bot) return null;
  const base = {
    channel: "telegram" as const,
    eventId,
    externalUserId: String(message.from.id),
    chatId: String(message.chat.id),
    chatType: chatTypeOf(message.chat.type),
    username: message.from.username,
  };

  if (message.photo) {
    return { ...base, kind: "photo", ...(message.caption ? { text: message.caption } : {}) };
  }
  if (typeof message.text !== "string") return null;

  const command = parseCommand(message, botUsername);
  if (command) return { ...base, kind: "command", text: message.text, ...command };
  return { ...base, kind: "text", text: message.text };
}
