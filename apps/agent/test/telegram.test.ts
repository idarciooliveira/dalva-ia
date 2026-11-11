import { describe, expect, test } from "vitest";

import { decodeButtonPayload, encodeButtonPayload } from "../src/channels/channel";
import { escapeHtml, renderHtml } from "../src/channels/telegram/format";
import { captureLogger, fixture, telegramAdapter } from "./helpers";

describe("telegram parse", () => {
  const { logger } = captureLogger();
  const { adapter } = telegramAdapter(logger);

  test("private text", () => {
    expect(adapter.parse(fixture("private-text"))).toEqual({
      channel: "telegram",
      eventId: "900000001",
      externalUserId: "424242",
      chatId: "424242",
      chatType: "private",
      kind: "text",
      text: "spent 12 on lunch <b>secret-note</b>",
      username: "ana_s",
    });
  });

  test("command with args, addressed to this bot", () => {
    expect(adapter.parse(fixture("command-with-args"))).toMatchObject({
      eventId: "900000002",
      kind: "command",
      command: "start",
      args: ["AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde"],
      chatType: "private",
    });
  });

  test("a command addressed to another bot is plain text", () => {
    const update = fixture("command-with-args");
    update.message.text = update.message.text.replace("dalva_test_bot", "other_test_bot");
    update.message.entities[0].length = 22;
    expect(adapter.parse(update)).toMatchObject({ kind: "text" });
  });

  test("commands are case-insensitive and args split on whitespace", () => {
    const update = fixture("command-with-args");
    update.message.text = "/Balance   a  b";
    update.message.entities[0].length = 8;
    expect(adapter.parse(update)).toMatchObject({ kind: "command", command: "balance", args: ["a", "b"] });
  });

  test("callback query", () => {
    expect(adapter.parse(fixture("callback-query"))).toEqual({
      channel: "telegram",
      eventId: "900000003",
      externalUserId: "424242",
      chatId: "424242",
      chatType: "private",
      kind: "button",
      buttonPayload: "c:k17abc_def-123",
      buttonId: "4382bfdwdsb323b2d9",
      username: "ana_s",
    });
  });

  test("group message", () => {
    expect(adapter.parse(fixture("group-message"))).toMatchObject({
      chatId: "-1001234567890",
      chatType: "group",
      kind: "command",
      command: "balance",
    });
  });

  test("photo with caption", () => {
    expect(adapter.parse(fixture("photo"))).toMatchObject({ kind: "photo", text: "receipt from the market", chatType: "private" });
  });

  test("unsupported updates and garbage are ignored", () => {
    expect(adapter.parse(fixture("edited-message"))).toBeNull();
    expect(adapter.parse(null)).toBeNull();
    expect(adapter.parse("nope")).toBeNull();
    expect(adapter.parse({ update_id: "1" })).toBeNull();
    expect(adapter.parse({ update_id: 1, message: { from: null } })).toBeNull();
  });

  test("storable keeps exactly what parse needs", () => {
    for (const name of ["private-text", "command-with-args", "callback-query", "group-message", "photo"]) {
      const raw = fixture(name);
      const stored = JSON.parse(JSON.stringify(adapter.storable(raw)));
      expect(adapter.parse(stored)).toEqual(adapter.parse(raw));
      expect(JSON.stringify(stored)).not.toContain("first_name");
    }
  });

  test("messages from bots are ignored", () => {
    const update = fixture("private-text");
    update.message.from.is_bot = true;
    expect(adapter.parse(update)).toBeNull();
  });
});

describe("telegram send", () => {
  test("escapes HTML and renders rich parts", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
    expect(renderHtml(["Hi ", { bold: "<you>" }, " ", { code: "1 < 2" }, { italic: "&" }])).toBe(
      "Hi <b>&lt;you&gt;</b> <code>1 &lt; 2</code><i>&amp;</i>",
    );
  });

  test("text uses HTML parse mode", async () => {
    const { adapter, telegram } = telegramAdapter(captureLogger().logger);
    await adapter.send({ chatId: "42" }, { type: "text", text: "a <b> & c" });
    expect(telegram.sent).toEqual([{ chatId: "42", html: "a &lt;b&gt; &amp; c", replyMarkup: undefined }]);
  });

  test("confirm adds confirm/cancel buttons carrying the action id", async () => {
    const { adapter, telegram } = telegramAdapter(captureLogger().logger);
    await adapter.send({ chatId: "42" }, { type: "confirm", text: "Add expense?", actionId: "act_123" });
    const markup = telegram.sent[0]!.replyMarkup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    const payloads = markup.inline_keyboard.flat().map((button) => button.callback_data);
    expect(payloads).toEqual(["c:act_123", "x:act_123"]);
    expect(payloads.map(decodeButtonPayload)).toEqual([
      { action: "confirm", actionId: "act_123" },
      { action: "cancel", actionId: "act_123" },
    ]);
  });

  test("confirm refuses an action id that overflows callback data", async () => {
    const { adapter } = telegramAdapter(captureLogger().logger);
    await expect(adapter.send({ chatId: "42" }, { type: "confirm", text: "x", actionId: "a".repeat(70) })).rejects.toThrow();
  });

  test("typing and button answers", async () => {
    const { adapter, telegram } = telegramAdapter(captureLogger().logger);
    await adapter.send({ chatId: "42" }, { type: "typing" });
    await adapter.answerButton("cb1", "later");
    expect(telegram.actions).toEqual([{ chatId: "42", action: "typing" }]);
    expect(telegram.answered).toEqual([{ id: "cb1", text: "later" }]);
  });

  test("button payload codec rejects garbage", () => {
    expect(encodeButtonPayload("cancel", "a1")).toBe("x:a1");
    expect(decodeButtonPayload("z:a1")).toBeNull();
    expect(decodeButtonPayload("c:../x")).toBeNull();
  });
});
