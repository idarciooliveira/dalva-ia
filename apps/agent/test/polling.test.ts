import { describe, expect, test } from "vitest";

import type { DeliverResult } from "../src/channels/channel";
import { createTelegramAdapter, type TelegramApi } from "../src/channels/telegram/adapter";
import { BOT_TOKEN, BOT_USERNAME, captureLogger, textUpdate, waitFor } from "./helpers";

/** getUpdates that serves scripted updates, honouring `offset` like Telegram (everything below it is confirmed). */
function pollingApi(pending: Array<ReturnType<typeof textUpdate>>) {
  const offsets: number[] = [];
  let webhookDeleted = false;
  const api = {
    deleteWebhook: async () => {
      webhookDeleted = true;
      return true;
    },
    getUpdates: async (other: { offset: number }, signal: AbortSignal) => {
      offsets.push(other.offset);
      const batch = pending.filter((u) => u.update_id >= other.offset);
      if (batch.length > 0) return batch;
      // Long poll: wait until aborted.
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    },
  } as unknown as TelegramApi;
  return { api, offsets, webhookDeleted: () => webhookDeleted };
}

function adapterWith(api: TelegramApi) {
  return createTelegramAdapter({ token: BOT_TOKEN, botUsername: BOT_USERNAME, mode: "polling", logger: captureLogger().logger, api, pollRetryMs: 1 });
}

const idOf = (raw: unknown) => (raw as { update_id: number }).update_id;

describe("telegram polling", () => {
  test("deletes the webhook, delivers updates one by one and confirms them through the offset", async () => {
    const telegram = pollingApi([textUpdate(1, "a"), textUpdate(2, "b")]);
    const adapter = adapterWith(telegram.api);
    const delivered: number[] = [];
    await adapter.start(async (raw) => {
      delivered.push(idOf(raw));
      return "accepted";
    });
    await waitFor(() => telegram.offsets.length >= 2);
    await adapter.stop();
    expect(telegram.webhookDeleted()).toBe(true);
    expect(delivered).toEqual([1, 2]);
    expect(telegram.offsets.slice(0, 2)).toEqual([0, 3]);
  });

  test.each(["failed", "overloaded"] as const)("a %s update is not confirmed and is fetched again", async (refusal) => {
    const telegram = pollingApi([textUpdate(1, "a"), textUpdate(2, "b")]);
    const adapter = adapterWith(telegram.api);
    const results: DeliverResult[] = ["accepted", refusal];
    const delivered: number[] = [];
    await adapter.start(async (raw) => {
      delivered.push(idOf(raw));
      return results.shift() ?? "accepted";
    });
    await waitFor(() => delivered.filter((id) => id === 2).length === 2);
    await adapter.stop();
    // Update 2 was refused: the next poll still starts at 2, so Telegram keeps it.
    expect(telegram.offsets.slice(0, 2)).toEqual([0, 2]);
    expect(delivered.slice(0, 3)).toEqual([1, 2, 2]);
  });

  test("the next poll waits for the current claim, and stop() then confirms nothing", async () => {
    const telegram = pollingApi([textUpdate(1, "a")]);
    const adapter = adapterWith(telegram.api);
    let release!: (result: DeliverResult) => void;
    await adapter.start(() => new Promise<DeliverResult>((resolve) => (release = resolve)));
    await waitFor(() => release !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(telegram.offsets).toEqual([0]);
    const stopping = adapter.stop();
    release("accepted");
    await stopping;
    expect(telegram.offsets).toEqual([0]);
  });

  test("stop() during start() keeps polling from starting", async () => {
    const telegram = pollingApi([textUpdate(1, "a")]);
    let releaseDelete!: () => void;
    const api = {
      ...(telegram.api as object),
      deleteWebhook: () => new Promise<true>((resolve) => (releaseDelete = () => resolve(true))),
    } as unknown as TelegramApi;
    const adapter = adapterWith(api);
    const starting = adapter.start(async () => "accepted");
    await adapter.stop();
    releaseDelete();
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(telegram.offsets).toHaveLength(0);
  });
});
