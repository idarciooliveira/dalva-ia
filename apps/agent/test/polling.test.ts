import { describe, expect, test } from "vitest";

import type { DeliverResult } from "../src/channels/channel";
import { createTelegramAdapter, type TelegramApi } from "../src/channels/telegram/adapter";
import { BOT_TOKEN, BOT_USERNAME, captureLogger, textUpdate, waitFor } from "./helpers";

/** getUpdates that serves scripted batches, honouring `offset` and `limit` like Telegram. */
function pollingApi(pending: Array<ReturnType<typeof textUpdate>>) {
  const requests: Array<{ offset: number; limit: number }> = [];
  let webhookDeleted = false;
  const api = {
    deleteWebhook: async () => {
      webhookDeleted = true;
      return true;
    },
    getUpdates: async (other: { offset: number; limit: number }, signal: AbortSignal) => {
      requests.push({ offset: other.offset, limit: other.limit });
      const batch = pending.filter((u) => u.update_id >= other.offset).slice(0, other.limit);
      if (batch.length > 0) return batch;
      // Long poll: wait until aborted.
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    },
  } as unknown as TelegramApi;
  return { api, requests, webhookDeleted: () => webhookDeleted };
}

function adapterWith(api: TelegramApi) {
  return createTelegramAdapter({ token: BOT_TOKEN, botUsername: BOT_USERNAME, mode: "polling", logger: captureLogger().logger, api, pollRetryMs: 1 });
}

describe("telegram polling", () => {
  test("deletes the webhook, delivers updates and confirms them through the offset", async () => {
    const telegram = pollingApi([textUpdate(1, "a"), textUpdate(2, "b")]);
    const adapter = adapterWith(telegram.api);
    const delivered: number[] = [];
    await adapter.start(
      (raw) => {
        delivered.push((raw as { update_id: number }).update_id);
        return "accepted";
      },
      { available: () => 100, wait: async () => {}, persisted: async () => {} },
    );
    await waitFor(() => telegram.requests.length >= 2);
    await adapter.stop();
    expect(telegram.webhookDeleted()).toBe(true);
    expect(delivered).toEqual([1, 2]);
    expect(telegram.requests[1]).toMatchObject({ offset: 3 });
  });

  test("never fetches more than the pipeline can take, and leaves overloaded updates unconfirmed", async () => {
    const telegram = pollingApi([textUpdate(1, "a"), textUpdate(2, "b"), textUpdate(3, "c")]);
    const adapter = adapterWith(telegram.api);
    const results: DeliverResult[] = ["accepted", "overloaded"];
    const delivered: number[] = [];
    let room = 2;
    await adapter.start(
      (raw) => {
        delivered.push((raw as { update_id: number }).update_id);
        return results.shift() ?? "accepted";
      },
      { available: () => room, wait: async () => {}, persisted: async () => {} },
    );
    await waitFor(() => delivered.length >= 3);
    room = 100;
    await waitFor(() => delivered.includes(3));
    await adapter.stop();
    expect(telegram.requests[0]).toMatchObject({ offset: 0, limit: 2 });
    // Update 2 was refused, so the next poll starts at 2 again.
    expect(telegram.requests[1]).toMatchObject({ offset: 2 });
    expect(delivered.slice(0, 3)).toEqual([1, 2, 2]);
  });

  test("stop() returns while waiting for capacity", async () => {
    const telegram = pollingApi([]);
    const adapter = adapterWith(telegram.api);
    await adapter.start(() => "accepted", { available: () => 0, wait: () => new Promise(() => {}), persisted: async () => {} });
    await adapter.stop();
    expect(telegram.requests).toHaveLength(0);
  });

  test("the next poll (which confirms the batch) waits until the batch is stored", async () => {
    const telegram = pollingApi([textUpdate(1, "a")]);
    const adapter = adapterWith(telegram.api);
    let release!: () => void;
    const stored = new Promise<void>((resolve) => (release = resolve));
    await adapter.start(() => "accepted", { available: () => 100, wait: async () => {}, persisted: () => stored });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(telegram.requests).toHaveLength(1);
    release();
    await waitFor(() => telegram.requests.length === 2);
    await adapter.stop();
    expect(telegram.requests[1]).toMatchObject({ offset: 2 });
  });

  test("stop() during start() keeps polling from starting", async () => {
    const telegram = pollingApi([textUpdate(1, "a")]);
    let releaseDelete!: () => void;
    const api = {
      ...(telegram.api as object),
      deleteWebhook: () => new Promise<true>((resolve) => (releaseDelete = () => resolve(true))),
    } as unknown as TelegramApi;
    const adapter = adapterWith(api);
    const starting = adapter.start(() => "accepted", { available: () => 100, wait: async () => {}, persisted: async () => {} });
    await adapter.stop();
    releaseDelete();
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(telegram.requests).toHaveLength(0);
  });

  test("stop() interrupts a slow persist wait and leaves the batch unconfirmed", async () => {
    const telegram = pollingApi([textUpdate(1, "a")]);
    const adapter = adapterWith(telegram.api);
    await adapter.start(() => "accepted", { available: () => 100, wait: async () => {}, persisted: () => new Promise(() => {}) });
    await waitFor(() => telegram.requests.length === 1);
    const started = Date.now();
    await adapter.stop();
    expect(Date.now() - started).toBeLessThan(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Only the first fetch: no getUpdates with offset 2 ever confirmed update 1.
    expect(telegram.requests).toEqual([{ offset: 0, limit: 100 }]);
  });
});
