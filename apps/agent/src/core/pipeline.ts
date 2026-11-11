import type { Channel } from "@mpf/finance-contract";
import { AGENT_EVENT_PAYLOAD_MAX_BYTES } from "@mpf/finance-contract";

import type { ChannelAdapter, DeliverResult, InboundEvent } from "../channels/channel";
import { errorFields, type Logger } from "../log";
import type { FinanceServiceClient } from "./finance";
import { isFinanceError } from "./finance";
import { ChatQueues, Semaphore, type ChatQueueLimits } from "./queue";

export type EventHandler = (event: InboundEvent) => Promise<void>;

export interface PipelineOptions {
  adapter: ChannelAdapter;
  service: FinanceServiceClient;
  handle: EventHandler;
  logger: Logger;
  limits?: Partial<ChatQueueLimits>;
  /** Called when handling a claimed event failed, to tell the user. Best effort. */
  onFailure?: (event: InboundEvent) => Promise<void>;
  /** Events that pass are claimed and handled; the rest are dropped before anything is stored. */
  accept?: (event: InboundEvent) => boolean;
  /** Pause before retrying an ambiguous claim or status update. */
  retryDelayMs?: number;
}

export interface Pipeline {
  /**
   * Parse, reserve a queue slot, and claim (store) the event. Resolves once
   * the claim settled: only `accepted`, `duplicate` and `ignored` may be
   * acknowledged to the platform; `overloaded` and `failed` must be retried by it.
   */
  deliver(raw: unknown): Promise<DeliverResult>;
  /**
   * Boot only, before any intake: re-process events a dead process left
   * unfinished, in arrival order per chat, and wait until they're done.
   */
  recover(): Promise<number>;
  /** Refuse new events, then wait for queued ones. Returns whether everything finished in time. */
  shutdown(timeoutMs: number): Promise<boolean>;
  readonly size: number;
}

const DEFAULT_LIMITS: ChatQueueLimits = { maxPerChat: 20, maxTotal: 1000, maxConcurrent: 32 };
const CLAIM_ATTEMPTS = 3;
const STATUS_ATTEMPTS = 3;
const RECOVER_PAGE = 50;
const RECOVER_MAX_PAGES = 100;
const RECOVER_CONCURRENCY = 4;
const RECOVER_MAX_ATTEMPTS = 3;

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Error code stored on a failed event. Never the message: it can quote user input. */
function failureCode(error: unknown): string {
  if (isFinanceError(error)) return `finance:${error.code}`;
  const fields = errorFields(error);
  return String(fields.errorCode ?? fields.errorName ?? "error").slice(0, 100);
}

/** No answer, or an answer we can't trust: the request may or may not have been applied. */
const isAmbiguous = (error: unknown) =>
  isFinanceError(error, "network_error", "timeout", "aborted", "internal", "invalid_response");

type ClaimOutcome = "new" | "duplicate" | "failed";

export function createPipeline(options: PipelineOptions): Pipeline {
  const { adapter, service, handle, logger } = options;
  const channel: Channel = adapter.id;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const queues = new ChatQueues({ ...DEFAULT_LIMITS, ...options.limits }, (error) =>
    logger.error("queue_task_crashed", errorFields(error)),
  );
  let accepting = true;

  const eventLogger = (event: InboundEvent) =>
    logger.child({ eventId: event.eventId, chatId: event.chatId, kind: event.kind });

  async function setStatus(event: InboundEvent, status: "processing" | "done" | "failed", error?: string) {
    await service.agentEvents.updateStatus({ channel, eventId: event.eventId, status, ...(error ? { error } : {}) });
  }

  /**
   * Store the event (dedupe + recovery). After an ambiguous failure the claim
   * may have landed, so a `duplicate` on the retry is our own claim, not a redelivery.
   */
  async function claim(event: InboundEvent, raw: unknown, log: Logger): Promise<ClaimOutcome> {
    let payload: string | undefined;
    try {
      payload = JSON.stringify(adapter.storable(raw));
    } catch {
      payload = undefined;
    }
    if (payload === undefined || utf8Bytes(payload) > AGENT_EVENT_PAYLOAD_MAX_BYTES) {
      log.warn("event_unstorable");
      return "failed";
    }
    let ambiguous = false;
    for (let attempt = 1; ; attempt++) {
      try {
        const { status } = await service.agentEvents.claim({ channel, eventId: event.eventId, payload });
        if (status === "duplicate" && ambiguous) return "new";
        return status;
      } catch (error) {
        if (isAmbiguous(error) && attempt < CLAIM_ATTEMPTS) {
          ambiguous = true;
          await sleep(retryDelayMs * attempt);
          continue;
        }
        log.error("event_claim_failed", errorFields(error));
        return "failed";
      }
    }
  }

  /**
   * Final status, best effort: a few tries, then give up. A missed update
   * leaves the event recoverable, so the next boot runs it again; that's fine
   * because commands are read-only or idempotent.
   */
  async function settle(event: InboundEvent, status: "done" | "failed", log: Logger, error?: string) {
    for (let attempt = 1; attempt <= STATUS_ATTEMPTS; attempt++) {
      try {
        await setStatus(event, status, error);
        return;
      } catch (statusError) {
        if (isFinanceError(statusError, "conflict", "not_found")) return; // already final, or purged
        if (attempt === STATUS_ATTEMPTS) {
          log.error("event_status_failed", { ...errorFields(statusError), status });
          return;
        }
        await sleep(retryDelayMs * attempt);
      }
    }
  }

  async function process(event: InboundEvent) {
    const log = eventLogger(event);
    const started = Date.now();

    // Bookkeeping (counts an attempt toward maxAttempts); it never gates handling.
    try {
      await setStatus(event, "processing");
    } catch (error) {
      // conflict: the event is already done or failed, so there's nothing left to do.
      if (isFinanceError(error, "conflict")) {
        log.info("event_already_settled");
        return;
      }
      log.warn("event_status_failed", { ...errorFields(error), status: "processing" });
    }

    try {
      await handle(event);
    } catch (error) {
      log.error("event_failed", { ...errorFields(error), ms: Date.now() - started });
      try {
        await options.onFailure?.(event);
      } catch (noticeError) {
        log.warn("failure_notice_failed", errorFields(noticeError));
      }
      await settle(event, "failed", log, failureCode(error));
      return;
    }

    await settle(event, "done", log);
    log.info("event_done", { ms: Date.now() - started });
  }

  /** Queue `event` behind its chat; it runs once `ready` resolves to true. */
  function enqueue(event: InboundEvent, ready: Promise<boolean>) {
    return queues.enqueue(`${channel}:${event.chatId}`, async () => {
      if (await ready) await process(event);
    });
  }

  /** One page of `listRecoverable`, parsed. Unparseable events are marked failed. */
  async function recoverablePage(): Promise<{ ids: string[]; events: InboundEvent[] }> {
    const { items } = await service.agentEvents.listRecoverable({
      channel,
      olderThanSeconds: 0,
      maxAttempts: RECOVER_MAX_ATTEMPTS,
      limit: RECOVER_PAGE,
    });
    const events: InboundEvent[] = [];
    for (const item of items) {
      let event: InboundEvent | null = null;
      try {
        event = adapter.parse(JSON.parse(item.payload));
      } catch {
        event = null;
      }
      if (event && event.eventId === item.eventId) {
        events.push(event);
        continue;
      }
      logger.warn("recover_unparseable", { eventId: item.eventId });
      try {
        await service.agentEvents.updateStatus({ channel, eventId: item.eventId, status: "failed", error: "unparseable" });
      } catch (error) {
        logger.warn("event_status_failed", { ...errorFields(error), eventId: item.eventId, status: "failed" });
      }
    }
    return { ids: items.map((item) => item.eventId), events };
  }

  /** Run events one by one per chat, in arrival order; a few chats at a time. */
  async function runRecovered(events: InboundEvent[]) {
    const byChat = new Map<string, InboundEvent[]>();
    for (const event of events) byChat.set(event.chatId, [...(byChat.get(event.chatId) ?? []), event]);
    const slots = new Semaphore(RECOVER_CONCURRENCY);
    await Promise.all(
      [...byChat.values()].map((chatEvents) =>
        slots.run(async () => {
          // Arrival order, not the backend's last-update order: a chat's /forget must not run before its older messages.
          for (const event of chatEvents.sort((a, b) => a.sequence - b.sequence)) await process(event);
        }),
      ),
    );
  }

  return {
    get size() {
      return queues.size;
    },

    async deliver(raw) {
      if (!accepting) return "overloaded";
      const event = adapter.parse(raw);
      if (!event || (options.accept && !options.accept(event))) {
        logger.debug("event_ignored", event ? { eventId: event.eventId, kind: event.kind } : {});
        return "ignored";
      }
      const log = eventLogger(event);
      // Reserve the slot first (keeps arrival order), claim second: nothing is stored that can't be queued.
      let settle!: (claimed: boolean) => void;
      const claimed = new Promise<boolean>((resolve) => (settle = resolve));
      const queued = enqueue(event, claimed);
      if (queued !== "accepted") {
        log.warn(queued === "chat_full" ? "chat_queue_full" : "queue_full", { queued: queues.size });
        return "overloaded";
      }
      const outcome = await claim(event, raw, log);
      settle(outcome === "new");
      if (outcome === "duplicate") log.info("event_duplicate");
      return outcome === "new" ? "accepted" : outcome;
    },

    async recover() {
      // Intake is closed, so recovered events bypass the bounded live queues.
      const attempted = new Set<string>();
      let processed = 0;
      for (let page = 1; ; page++) {
        if (page > RECOVER_MAX_PAGES) {
          logger.warn("recover_page_cap", { pages: RECOVER_MAX_PAGES, processed });
          break;
        }
        const { ids, events } = await recoverablePage();
        const fresh = events.filter((event) => !attempted.has(event.eventId));
        for (const id of ids) attempted.add(id);
        // Empty, or only events this boot already ran (their status update failed): done.
        if (fresh.length === 0) break;
        await runRecovered(fresh);
        processed += fresh.length;
      }
      logger.info("recover_done", { processed });
      return processed;
    },

    async shutdown(timeoutMs) {
      accepting = false;
      const drained = await queues.drain(timeoutMs);
      logger.info("pipeline_drained", { drained, remaining: queues.size });
      return drained;
    },
  };
}
