import { describe, expect, test, vi } from "vitest";

import type { InboundEvent } from "../src/channels/channel";
import { createPipeline, type EventHandler } from "../src/core/pipeline";
import { ChatQueues } from "../src/core/queue";
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
  const pipeline = createPipeline({ adapter, service: finance.clients.service, handle, logger, limits, onFailure, accept });
  return { pipeline, finance, lines, onFailure };
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("pipeline", () => {
  test("claims, marks processing, handles, marks done", async () => {
    const handled: string[] = [];
    const { pipeline, finance } = setup(async (event) => {
      expect(finance.events.get(event.eventId)).toMatchObject({ status: "processing", attempts: 1 });
      handled.push(event.eventId);
    });
    expect(pipeline.deliver(textUpdate(1, "hi"))).toBe("accepted");
    await pipeline.shutdown(1000);
    expect(handled).toEqual(["1"]);
    expect(finance.events.get("1")).toMatchObject({ status: "done" });
    const claim = finance.callsTo("/agent/events/claim")[0]!;
    expect(JSON.parse(claim.body!.payload)).toMatchObject({ update_id: 1 });
  });

  test("a duplicate claim is dropped", async () => {
    const handle = vi.fn(async () => {});
    const { pipeline, finance, lines } = setup(handle);
    pipeline.deliver(textUpdate(7, "hi"));
    await waitFor(() => finance.events.get("7")?.status === "done");
    pipeline.deliver(textUpdate(7, "hi"));
    await pipeline.shutdown(1000);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(lines.some((line) => line.includes("event_duplicate"))).toBe(true);
  });

  test("events of one chat run in order, one at a time", async () => {
    const order: string[] = [];
    const gates = new Map([["1", deferred()]]);
    let running = 0;
    let maxRunning = 0;
    const { pipeline } = setup(async (event) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await gates.get(event.eventId)?.promise;
      order.push(event.eventId);
      running -= 1;
    });
    for (const id of [1, 2, 3]) pipeline.deliver(textUpdate(id, `m${id}`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual([]);
    gates.get("1")!.resolve();
    await pipeline.shutdown(1000);
    expect(order).toEqual(["1", "2", "3"]);
    expect(maxRunning).toBe(1);
  });

  test("different chats run concurrently", async () => {
    const slow = deferred();
    const done: string[] = [];
    const { pipeline } = setup(async (event) => {
      if (event.chatId === "1") await slow.promise;
      done.push(event.chatId);
    });
    pipeline.deliver(textUpdate(10, "a", 1));
    pipeline.deliver(textUpdate(11, "b", 2));
    await waitFor(() => done.includes("2"));
    expect(done).toEqual(["2"]);
    slow.resolve();
    await pipeline.shutdown(1000);
    expect(done).toEqual(["2", "1"]);
  });

  test("a failing handler marks the event failed with an error code, notifies, and the chat continues", async () => {
    const { pipeline, finance, onFailure, lines } = setup(async (event) => {
      if (event.eventId === "20") throw new Error("boom with user text: spent 12 on lunch");
    });
    pipeline.deliver(textUpdate(20, "x"));
    pipeline.deliver(textUpdate(21, "y"));
    await pipeline.shutdown(1000);
    expect(finance.events.get("20")).toMatchObject({ status: "failed", error: "Error" });
    expect(finance.events.get("21")).toMatchObject({ status: "done" });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).not.toContain("spent 12 on lunch");
  });

  test("a failing claim drops the event and tells the user", async () => {
    const handle = vi.fn(async () => {});
    const { pipeline, finance, onFailure } = setup(handle);
    finance.fail("POST /agent/events/claim", "network");
    pipeline.deliver(textUpdate(30, "x"));
    await pipeline.shutdown(1000);
    expect(handle).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  test("an event already settled elsewhere (conflict on processing) is skipped", async () => {
    const handle = vi.fn(async () => {});
    const { pipeline, finance } = setup(handle);
    finance.fail("POST /agent/events/status", "conflict");
    pipeline.deliver(textUpdate(31, "x"));
    await pipeline.shutdown(1000);
    expect(handle).not.toHaveBeenCalled();
  });

  test("boot recovery re-processes unfinished events, in order, without claiming again", async () => {
    const handled: string[] = [];
    const { pipeline, finance } = setup(async (event) => {
      handled.push(event.eventId);
    });
    finance.events.set("40", { eventId: "40", status: "processing", attempts: 1, payload: JSON.stringify(textUpdate(40, "a")) });
    finance.events.set("41", { eventId: "41", status: "received", attempts: 0, payload: JSON.stringify(textUpdate(41, "b")) });
    finance.events.set("42", { eventId: "42", status: "done", attempts: 1 });
    finance.events.set("43", { eventId: "43", status: "received", attempts: 0, payload: "{\"nope\":1}" });
    expect(await pipeline.recover({ olderThanSeconds: 0 })).toBe(2);
    await pipeline.shutdown(1000);
    expect(handled).toEqual(["40", "41"]);
    expect(finance.callsTo("/agent/events/claim")).toHaveLength(0);
    expect(finance.events.get("40")).toMatchObject({ status: "done", attempts: 2 });
    expect(finance.events.get("43")).toMatchObject({ status: "failed", error: "unparseable" });
    const recoverable = finance.callsTo("/agent/events/recoverable")[0]!;
    expect(recoverable.body).toMatchObject({ channel: "telegram", olderThanSeconds: "0" });
  });

  test("a full chat drops its excess; a full pipeline is overloaded", async () => {
    const gate = deferred();
    const { pipeline } = setup(async () => gate.promise, { maxPerChat: 2, maxTotal: 3 });
    expect(pipeline.deliver(textUpdate(50, "a", 1))).toBe("accepted");
    expect(pipeline.deliver(textUpdate(51, "b", 1))).toBe("accepted");
    expect(pipeline.deliver(textUpdate(52, "c", 1))).toBe("dropped");
    expect(pipeline.deliver(textUpdate(53, "d", 2))).toBe("accepted");
    expect(pipeline.deliver(textUpdate(54, "e", 3))).toBe("overloaded");
    gate.resolve();
    await pipeline.shutdown(1000);
    expect(pipeline.size).toBe(0);
  });

  test("shutdown drains queued events and then refuses new ones", async () => {
    const handled: string[] = [];
    const { pipeline } = setup(async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      handled.push(event.eventId);
    });
    pipeline.deliver(textUpdate(60, "a"));
    pipeline.deliver(textUpdate(61, "b", 2));
    expect(await pipeline.shutdown(1000)).toBe(true);
    expect(handled.sort()).toEqual(["60", "61"]);
    expect(pipeline.deliver(textUpdate(62, "c"))).toBe("overloaded");
  });

  test("shutdown gives up after the timeout", async () => {
    const { pipeline } = setup(() => new Promise(() => {}));
    pipeline.deliver(textUpdate(70, "a"));
    expect(await pipeline.shutdown(30)).toBe(false);
  });
});

describe("pipeline recovery and failures", () => {
  test("a failed processing update is retried by the next recovery pass", async () => {
    const handled: string[] = [];
    const { pipeline, finance } = setup(async (event) => {
      handled.push(event.eventId);
    });
    finance.fail("POST /agent/events/status", "network");
    pipeline.deliver(textUpdate(80, "a"));
    await waitFor(() => finance.calls.some((call) => call.path === "/agent/events/status"));
    await waitFor(() => pipeline.size === 0);
    expect(handled).toEqual([]);
    expect(finance.events.get("80")).toMatchObject({ status: "received" });
    expect(await pipeline.recover({ olderThanSeconds: 120 })).toBe(1);
    await pipeline.shutdown(1000);
    expect(handled).toEqual(["80"]);
    expect(finance.events.get("80")).toMatchObject({ status: "done" });
  });

  test("recovery skips events still queued in this process", async () => {
    const gate = deferred();
    const handled: string[] = [];
    const { pipeline, finance } = setup(async (event) => {
      await gate.promise;
      handled.push(event.eventId);
    });
    pipeline.deliver(textUpdate(81, "a"));
    pipeline.deliver(textUpdate(82, "b"));
    await waitFor(() => finance.events.has("81"));
    // 82 is claimed only once 81 is done, but 81 is processing and queued here.
    expect(await pipeline.recover({ olderThanSeconds: 0 })).toBe(0);
    gate.resolve();
    await pipeline.shutdown(1000);
    expect(handled).toEqual(["81", "82"]);
  });

  test("a failed done update is retried once", async () => {
    const gate = deferred();
    const { pipeline, finance } = setup(() => gate.promise);
    pipeline.deliver(textUpdate(83, "a"));
    await waitFor(() => finance.events.get("83")?.status === "processing");
    finance.fail("POST /agent/events/status", "network");
    gate.resolve();
    await pipeline.shutdown(1000);
    expect(finance.events.get("83")).toMatchObject({ status: "done" });
  });

  test("an oversized event is not claimed and the user is told", async () => {
    const handle = vi.fn(async () => {});
    const { pipeline, finance, onFailure } = setup(handle);
    pipeline.deliver(textUpdate(84, "x".repeat(40_000)));
    await pipeline.shutdown(1000);
    expect(finance.callsTo("/agent/events/claim")).toHaveLength(0);
    expect(handle).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  test("events the accept filter refuses are never claimed", async () => {
    const handle = vi.fn(async () => {});
    const { pipeline, finance } = setup(handle, undefined, (event) => event.chatType === "private");
    expect(pipeline.deliver(textUpdate(85, "hi all", 1, -100))).toBe("ignored");
    await pipeline.shutdown(1000);
    expect(finance.calls).toHaveLength(0);
    expect(handle).not.toHaveBeenCalled();
  });

  test("a non-finance error is stored as its name only", async () => {
    const { pipeline, finance } = setup(async () => {
      throw Object.assign(new Error("Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)"), {
        name: "GrammyError",
        error_code: 403,
      });
    });
    pipeline.deliver(textUpdate(86, "a"));
    await pipeline.shutdown(1000);
    expect(finance.events.get("86")).toMatchObject({ status: "failed", error: "GrammyError" });
  });

  test("at most maxConcurrent chats run at once", async () => {
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
    for (let chat = 1; chat <= 6; chat++) pipeline.deliver(textUpdate(90 + chat, "a", chat));
    await pipeline.shutdown(2000);
    expect(peak).toBe(2);
  });
});

describe("ChatQueues", () => {
  test("waitForCapacity resolves once a slot frees up", async () => {
    const queues = new ChatQueues({ maxPerChat: 5, maxTotal: 1, maxConcurrent: 5 });
    const gate = deferred();
    queues.enqueue("a", () => gate.promise);
    let resolved = false;
    void queues.waitForCapacity().then(() => (resolved = true));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(resolved).toBe(false);
    gate.resolve();
    await waitFor(() => resolved);
  });

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
});
