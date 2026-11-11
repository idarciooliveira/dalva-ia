import { describe, expect, test, vi } from "vitest";

import type { InboundEvent } from "../src/channels/channel";
import { createPipeline, type EventHandler } from "../src/core/pipeline";
import { ChatQueues, Semaphore } from "../src/core/queue";
import { captureLogger, fakeFinance, telegramAdapter, textUpdate, waitFor } from "./helpers";

function setup(
  handle: EventHandler,
  limits?: { maxPerChat?: number; maxTotal?: number; maxConcurrent?: number },
  accept?: (event: InboundEvent) => boolean,
) {
  const { logger, lines } = captureLogger();
  const { adapter } = telegramAdapter(logger);
  const finance = fakeFinance();
  const onFailure = vi.fn(async (_event: InboundEvent) => {});
  const pipeline = createPipeline({ adapter, service: finance.clients.service, handle, logger, limits, onFailure, accept, retryDelayMs: 1 });
  return { pipeline, finance, lines, onFailure };
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

const stored = (finance: ReturnType<typeof fakeFinance>, id: number, text: string, chat = 424242) =>
  finance.events.set(String(id), { eventId: String(id), status: "received", attempts: 0, payload: JSON.stringify(textUpdate(id, text, chat)) });

describe("pipeline intake", () => {
  test("deliver resolves accepted only once the claim landed; then processing, handle, done", async () => {
    const handled: string[] = [];
    const { pipeline, finance } = setup(async (event) => {
      expect(finance.events.get(event.eventId)).toMatchObject({ status: "processing", attempts: 1 });
      handled.push(event.eventId);
    });
    const release = finance.hold("POST /agent/events/claim");
    let result: string | undefined;
    const delivering = pipeline.deliver(textUpdate(1, "hi")).then((r) => (result = r));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result).toBeUndefined();
    release();
    await delivering;
    expect(result).toBe("accepted");
    expect(finance.events.has("1")).toBe(true);
    await pipeline.shutdown(1000);
    expect(handled).toEqual(["1"]);
    expect(finance.events.get("1")).toMatchObject({ status: "done" });
  });

  test("a duplicate is acknowledged and dropped", async () => {
    const handle = vi.fn(async () => {});
    const { pipeline } = setup(handle);
    expect(await pipeline.deliver(textUpdate(7, "hi"))).toBe("accepted");
    expect(await pipeline.deliver(textUpdate(7, "hi"))).toBe("duplicate");
    await pipeline.shutdown(1000);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  test("a full chat or a full pipeline is overloaded, and nothing is claimed", async () => {
    const gate = deferred();
    const { pipeline, finance } = setup(async () => gate.promise, { maxPerChat: 2, maxTotal: 3 });
    expect(await pipeline.deliver(textUpdate(50, "a", 1))).toBe("accepted");
    expect(await pipeline.deliver(textUpdate(51, "b", 1))).toBe("accepted");
    expect(await pipeline.deliver(textUpdate(52, "c", 1))).toBe("overloaded");
    expect(await pipeline.deliver(textUpdate(53, "d", 2))).toBe("accepted");
    expect(await pipeline.deliver(textUpdate(54, "e", 3))).toBe("overloaded");
    expect([...finance.events.keys()].sort()).toEqual(["50", "51", "53"]);
    gate.resolve();
    await pipeline.shutdown(1000);
  });

  test("a claim that keeps failing is reported failed (for the platform to retry), never handled, no reply", async () => {
    const handle = vi.fn(async () => {});
    const { pipeline, finance, onFailure } = setup(handle);
    finance.fail("POST /agent/events/claim", "network", 3);
    expect(await pipeline.deliver(textUpdate(30, "x"))).toBe("failed");
    await pipeline.shutdown(1000);
    expect(handle).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    expect(pipeline.size).toBe(0);
  });

  test("a claim that landed but whose reply was lost is retried and processed once", async () => {
    const handle = vi.fn(async () => {});
    const { pipeline, finance } = setup(handle);
    finance.fail("POST /agent/events/claim", "network_after");
    expect(await pipeline.deliver(textUpdate(32, "x"))).toBe("accepted");
    await pipeline.shutdown(1000);
    expect(finance.callsTo("/agent/events/claim")).toHaveLength(2);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(finance.events.get("32")).toMatchObject({ status: "done" });
  });

  test("an unstorable event is failed without a claim", async () => {
    const { pipeline, finance } = setup(async () => {});
    expect(await pipeline.deliver(textUpdate(84, "x".repeat(40_000)))).toBe("failed");
    await pipeline.shutdown(1000);
    expect(finance.callsTo("/agent/events/claim")).toHaveLength(0);
  });

  test("events the accept filter refuses are ignored, never claimed", async () => {
    const handle = vi.fn(async () => {});
    const { pipeline, finance } = setup(handle, undefined, (event) => event.chatType === "private");
    expect(await pipeline.deliver(textUpdate(85, "hi all", 1, -100))).toBe("ignored");
    await pipeline.shutdown(1000);
    expect(finance.calls).toHaveLength(0);
  });

  test("stores only what recovery needs: no names, no quoted messages", async () => {
    const { pipeline, finance } = setup(async () => {});
    const update = textUpdate(35, "hi") as Record<string, any>;
    update.message.reply_to_message = { message_id: 1, text: "someone else's secret" };
    update.message.from.first_name = "Ana";
    await pipeline.deliver(update);
    await pipeline.shutdown(1000);
    const payload = finance.callsTo("/agent/events/claim")[0]!.body!.payload as string;
    expect(payload).not.toContain("someone else's secret");
    expect(payload).not.toContain("Ana");
    expect(JSON.parse(payload)).toMatchObject({ update_id: 35, message: { text: "hi", chat: { id: 424242, type: "private" } } });
  });
});

describe("pipeline processing", () => {
  test("events of one chat run in order, one at a time", async () => {
    const order: string[] = [];
    const first = deferred();
    let running = 0;
    let maxRunning = 0;
    const { pipeline } = setup(async (event) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      if (event.eventId === "1") await first.promise;
      order.push(event.eventId);
      running -= 1;
    });
    for (const id of [1, 2, 3]) await pipeline.deliver(textUpdate(id, `m${id}`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual([]);
    first.resolve();
    await pipeline.shutdown(1000);
    expect(order).toEqual(["1", "2", "3"]);
    expect(maxRunning).toBe(1);
  });

  test("different chats run concurrently, up to maxConcurrent", async () => {
    let running = 0;
    let peak = 0;
    const { pipeline } = setup(
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
      },
      { maxConcurrent: 2 },
    );
    for (let chat = 1; chat <= 6; chat++) await pipeline.deliver(textUpdate(90 + chat, "a", chat));
    await pipeline.shutdown(2000);
    expect(peak).toBe(2);
  });

  test("a failing handler marks the event failed with an error code and notifies; the chat continues", async () => {
    const { pipeline, finance, onFailure, lines } = setup(async (event) => {
      if (event.eventId === "20") throw new Error("boom with user text: spent 12 on lunch");
    });
    await pipeline.deliver(textUpdate(20, "x"));
    await pipeline.deliver(textUpdate(21, "y"));
    await pipeline.shutdown(1000);
    expect(finance.events.get("20")).toMatchObject({ status: "failed", error: "Error" });
    expect(finance.events.get("21")).toMatchObject({ status: "done" });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).not.toContain("spent 12 on lunch");
  });

  test("a non-finance error is stored as its name only", async () => {
    const { pipeline, finance } = setup(async () => {
      throw Object.assign(new Error("Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)"), {
        name: "GrammyError",
        error_code: 403,
      });
    });
    await pipeline.deliver(textUpdate(86, "a"));
    await pipeline.shutdown(1000);
    expect(finance.events.get("86")).toMatchObject({ status: "failed", error: "GrammyError" });
  });

  test("an event already settled (conflict on processing) is skipped", async () => {
    const handle = vi.fn(async () => {});
    const { pipeline, finance } = setup(handle);
    finance.fail("POST /agent/events/status", "conflict");
    await pipeline.deliver(textUpdate(31, "x"));
    await pipeline.shutdown(1000);
    expect(handle).not.toHaveBeenCalled();
  });

  test("a failed processing update doesn't stop handling: the message is handled and replied to", async () => {
    const handled: string[] = [];
    const { pipeline, finance } = setup(async (event) => {
      handled.push(event.eventId);
    });
    finance.fail("POST /agent/events/status", "network");
    await pipeline.deliver(textUpdate(36, "x"));
    await pipeline.shutdown(1000);
    expect(handled).toEqual(["36"]);
    expect(finance.events.get("36")).toMatchObject({ status: "done" });
  });

  test("a final status that keeps failing is given up after 3 tries; the event stays recoverable", async () => {
    const gate = deferred();
    const { pipeline, finance, lines } = setup(() => gate.promise);
    await pipeline.deliver(textUpdate(37, "a"));
    await waitFor(() => finance.events.get("37")?.status === "processing");
    finance.fail("POST /agent/events/status", "network", 3);
    gate.resolve();
    await pipeline.shutdown(1000);
    expect(finance.events.get("37")).toMatchObject({ status: "processing" });
    expect(finance.callsTo("/agent/events/status")).toHaveLength(4);
    expect(lines.some((line) => line.includes("event_status_failed") && line.includes('"status":"done"'))).toBe(true);
  });

  test("a failed done update is retried", async () => {
    const gate = deferred();
    const { pipeline, finance } = setup(() => gate.promise);
    await pipeline.deliver(textUpdate(83, "a"));
    await waitFor(() => finance.events.get("83")?.status === "processing");
    finance.fail("POST /agent/events/status", "network");
    gate.resolve();
    await pipeline.shutdown(1000);
    expect(finance.events.get("83")).toMatchObject({ status: "done" });
  });
});

describe("pipeline boot recovery", () => {
  test("re-processes unfinished events without claiming again, and waits until they are done", async () => {
    const handled: string[] = [];
    const { pipeline, finance } = setup(async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      handled.push(event.eventId);
    });
    finance.events.set("40", { eventId: "40", status: "processing", attempts: 1, payload: JSON.stringify(textUpdate(40, "a")) });
    stored(finance, 41, "b");
    finance.events.set("42", { eventId: "42", status: "done", attempts: 1 });
    finance.events.set("43", { eventId: "43", status: "received", attempts: 0, payload: "{\"nope\":1}" });
    expect(await pipeline.recover()).toBe(2);
    expect(handled).toEqual(["40", "41"]); // done when recover() resolves
    expect(finance.callsTo("/agent/events/claim")).toHaveLength(0);
    expect(finance.events.get("40")).toMatchObject({ status: "done", attempts: 2 });
    expect(finance.events.get("43")).toMatchObject({ status: "failed", error: "unparseable" });
    expect(finance.callsTo("/agent/events/recoverable")[0]!.body).toMatchObject({ channel: "telegram", olderThanSeconds: "0" });
  });

  test("runs each chat's events in arrival (update_id) order, not the backend's last-update order", async () => {
    const handled: string[] = [];
    const { pipeline, finance } = setup(async (event) => {
      handled.push(`${event.chatId}:${event.eventId}`);
    });
    for (const [id, chat, text] of [
      [205, 1, "/forget"],
      [201, 1, "first"],
      [302, 2, "b"],
      [203, 1, "third"],
      [301, 2, "a"],
      [202, 1, "second"],
    ] as const) {
      stored(finance, id, text, chat);
    }
    expect(await pipeline.recover()).toBe(6);
    expect(handled.filter((h) => h.startsWith("1:"))).toEqual(["1:201", "1:202", "1:203", "1:205"]);
    expect(handled.filter((h) => h.startsWith("2:"))).toEqual(["2:301", "2:302"]);
  });

  test("25 recoverable events of one chat all run, in order (no live-queue cap)", async () => {
    const handled: number[] = [];
    const { pipeline, finance } = setup(async (event) => {
      handled.push(event.sequence);
    }, { maxPerChat: 20 });
    for (let i = 24; i >= 0; i--) stored(finance, 3000 + i, "x"); // listed newest first
    expect(await pipeline.recover()).toBe(25);
    expect(handled).toEqual(Array.from({ length: 25 }, (_, i) => 3000 + i));
  });

  test("pages until the list is empty", async () => {
    const handled: string[] = [];
    const { pipeline, finance } = setup(async (event) => {
      handled.push(event.eventId);
    });
    for (let i = 0; i < 60; i++) stored(finance, 1000 + i, "x", 5000 + i);
    expect(await pipeline.recover()).toBe(60);
    expect(handled).toHaveLength(60);
    expect(finance.callsTo("/agent/events/recoverable")).toHaveLength(3);
  });

  test("stops when a page holds only events this boot already ran (their status can't be updated)", async () => {
    const handle = vi.fn(async () => {});
    const { pipeline, finance } = setup(handle);
    for (let i = 0; i < 5; i++) stored(finance, 2000 + i, "x", 6000 + i);
    finance.fail("POST /agent/events/status", "network", 1000);
    expect(await pipeline.recover()).toBe(5);
    expect(handle).toHaveBeenCalledTimes(5); // handled despite the failing status updates, and only once
    expect(finance.callsTo("/agent/events/recoverable")).toHaveLength(2);
  });

  test("a backend outage fails recovery (boot is fatal, the container restarts)", async () => {
    const { pipeline, finance } = setup(async () => {});
    finance.fail("GET /agent/events/recoverable", "network");
    await expect(pipeline.recover()).rejects.toThrow();
  });
});

describe("pipeline shutdown", () => {
  test("drains everything accepted, including events still waiting for their claim, then refuses new ones", async () => {
    const handled: string[] = [];
    const { pipeline, finance } = setup(async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      handled.push(event.eventId);
    });
    await pipeline.deliver(textUpdate(60, "a"));
    await pipeline.deliver(textUpdate(61, "b", 2));
    const release = finance.hold("POST /agent/events/claim");
    const late = pipeline.deliver(textUpdate(62, "c", 3)); // claim in flight when shutdown starts
    await waitFor(() => finance.callsTo("/agent/events/claim").length === 3);
    const draining = pipeline.shutdown(1000);
    release();
    expect(await late).toBe("accepted");
    expect(await draining).toBe(true);
    expect(handled.sort()).toEqual(["60", "61", "62"]);
    expect(await pipeline.deliver(textUpdate(63, "d"))).toBe("overloaded");
  });

  test("gives up after the timeout", async () => {
    const { pipeline } = setup(() => new Promise(() => {}));
    await pipeline.deliver(textUpdate(70, "a"));
    expect(await pipeline.shutdown(30)).toBe(false);
  });
});

describe("Semaphore", () => {
  test("never runs more than max at once, and serves waiters in order", async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        semaphore.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          order.push(n);
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(order.slice(2)).toEqual([3, 4, 5]);
  });
});

describe("ChatQueues", () => {
  test("a task that throws doesn't stall its chat", async () => {
    const errors: unknown[] = [];
    const queues = new ChatQueues({ maxPerChat: 5, maxTotal: 5, maxConcurrent: 5 }, (error) => errors.push(error));
    const ran: number[] = [];
    queues.enqueue("a", async () => {
      throw new Error("x");
    });
    queues.enqueue("a", async () => {
      ran.push(2);
    });
    await queues.drain(1000);
    expect(ran).toEqual([2]);
    expect(errors).toHaveLength(1);
  });

  test("drain(Infinity) waits for the tasks", async () => {
    const queues = new ChatQueues({ maxPerChat: 5, maxTotal: 5, maxConcurrent: 5 });
    let done = false;
    queues.enqueue("a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      done = true;
    });
    expect(await queues.drain(Number.POSITIVE_INFINITY)).toBe(true);
    expect(done).toBe(true);
  });
});
