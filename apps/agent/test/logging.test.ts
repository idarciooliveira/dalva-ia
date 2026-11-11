import { describe, expect, test } from "vitest";

import { createHandler } from "../src/core/handler";
import { createPipeline } from "../src/core/pipeline";
import { createLogger, errorFields } from "../src/log";
import { BOT_TOKEN, captureLogger, fakeFinance, fixture, SERVICE_KEY, telegramAdapter, textUpdate, WEBHOOK_SECRET } from "./helpers";

const SECRET_TEXT = "my card pin is 9911 and I spent 12 on lunch";
const CODE = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";

describe("logs", () => {
  test("are JSON lines with ids and kinds, never message text, codes, tokens or keys", async () => {
    const { logger, lines } = captureLogger();
    const { adapter } = telegramAdapter(logger);
    const finance = fakeFinance();
    finance.link("424242", { displayName: "Ana Secret-Surname" });
    finance.accounts.push({ id: "acc_1", name: "Hidden Account Name", type: "bank", balance: { amountMinor: 987654, currency: "USD" } });
    finance.codes.set(CODE, "valid");
    const { handle, onFailure } = createHandler({ adapter, clients: finance.clients, logger, sessionIdleMinutes: 30 });
    const pipeline = createPipeline({ adapter, service: finance.clients.service, handle, onFailure, logger });

    pipeline.deliver(textUpdate(1, SECRET_TEXT));
    pipeline.deliver(textUpdate(2, "/balance"));
    pipeline.deliver(textUpdate(3, `/start ${CODE}`, 555, 555));
    pipeline.deliver(fixture("photo"));
    finance.fail("GET /accounts", "internal");
    pipeline.deliver(textUpdate(4, "/balance"));
    await pipeline.shutdown(2000);

    expect(lines.length).toBeGreaterThan(0);
    const records = lines.map((line) => JSON.parse(line));
    for (const record of records) expect(record).toMatchObject({ ts: expect.any(String), level: expect.any(String), msg: expect.any(String) });
    expect(records.some((r) => r.msg === "event_done" && r.eventId === "1" && r.kind === "text")).toBe(true);

    const all = lines.join("\n");
    for (const forbidden of [
      SECRET_TEXT,
      "spent 12",
      CODE,
      "receipt from the market",
      "Hidden Account Name",
      "9,876.54",
      "Secret-Surname",
      "tok_424242",
      BOT_TOKEN,
      SERVICE_KEY,
      WEBHOOK_SECRET,
    ]) {
      expect(all).not.toContain(forbidden);
    }
  });

  test("redacts forbidden keys and scrubs secrets from values", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", secrets: [SERVICE_KEY], write: (line) => lines.push(line) });
    logger.info(`calling with ${SERVICE_KEY}`, { text: "hello", token: "abc", eventId: "9", note: `k=${SERVICE_KEY}` });
    const record = JSON.parse(lines[0]!);
    expect(record).toMatchObject({ text: "[redacted]", token: "[redacted]", eventId: "9", note: "k=[redacted]" });
    expect(lines[0]).not.toContain(SERVICE_KEY);
  });

  test("respects the level", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "warn", write: (line) => lines.push(line) });
    logger.info("skip");
    logger.debug("skip");
    logger.warn("keep");
    expect(lines).toHaveLength(1);
  });

  test("errorFields keeps name and code, never the message", () => {
    const error = Object.assign(new Error(`failed for ${SECRET_TEXT}`), { code: "E1", status: 500 });
    const fields = errorFields(error);
    expect(fields).toEqual({ errorName: "Error", errorCode: "E1", errorStatus: 500 });
    expect(JSON.stringify(fields)).not.toContain("spent");
  });
});
