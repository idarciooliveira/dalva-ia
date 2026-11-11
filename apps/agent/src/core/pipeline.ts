import type { Channel } from "@mpf/finance-contract";
import { AGENT_EVENT_PAYLOAD_MAX_BYTES } from "@mpf/finance-contract";

import type { ChannelAdapter, DeliverResult, InboundEvent } from "../channels/channel";
import { errorFields, type Logger } from "../log";
import type { FinanceServiceClient } from "./finance";
import { isFinanceError } from "./finance";
import { ChatQueues, type ChatQueueLimits } from "./queue";

export type EventHandler = (event: InboundEvent) => Promise<void>;

export interface PipelineOptions {
  adapter: ChannelAdapter;
  service: FinanceServiceClient;
  handle: EventHandler;
  logger: Logger;
  limits?: Partial<ChatQueueLimits>;
  /** Called when handling failed, to tell the user. Best effort. */
  onFailure?: (event: InboundEvent) => Promise<void>;
  /** Events that pass are claimed and handled; the rest are dropped before anything is stored. */
  accept?: (event: InboundEvent) => boolean;
}

export interface RecoverOptions {
  /** Only events untouched for this long. 0 on boot; longer than any handling time afterwards. */
  olderThanSeconds: number;
}

export interface Pipeline {
  /** Synchronous: parse and enqueue a raw platform event. The caller answers the platform right away. */
  deliver(raw: unknown): DeliverResult;
  /**
   * Re-queue claimed events that never finished (crash, or a status update
   * that failed). Run on boot before accepting new events, then periodically.
   * Events already queued in this process are skipped.
   */
  recover(options: RecoverOptions): Promise<number>;
  /** Room left in the queues (for pulling transports). */
  available(): number;
  waitForCapacity(): Promise<void>;
  /** Refuse new events, then wait for queued ones. Returns whether everything finished in time. */
  shutdown(timeoutMs: number): Promise<boolean>;
  readonly size: number;
}

const DEFAULT_LIMITS: ChatQueueLimits = { maxPerChat: 20, maxTotal: 1000, maxConcurrent: 32 };
const RECOVER_PAGE = 50;
const RECOVER_MAX_PAGES = 10;
const RECOVER_MAX_ATTEMPTS = 3;

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/** Error code stored on a failed event. Never the message: it can quote user input. */
function failureCode(error: unknown): string {
  if (isFinanceError(error)) return `finance:${error.code}`;
  const fields = errorFields(error);
  return String(fields.errorCode ?? fields.errorName ?? "error").slice(0, 100);
}

export function createPipeline(options: PipelineOptions): Pipeline {
  const { adapter, service, handle, logger } = options;
  const channel: Channel = adapter.id;
  const queues = new ChatQueues({ ...DEFAULT_LIMITS, ...options.limits }, (error) =>
    logger.error("queue_task_crashed", errorFields(error)),
  );
  let accepting = true;
  /** Event ids queued or running here: recovery must not queue them twice. */
  const inFlight = new Set<string>();

  async function setStatus(event: InboundEvent, status: "processing" | "done" | "failed", error?: string) {
    await service.agentEvents.updateStatus({ channel, eventId: event.eventId, status, ...(error ? { error } : {}) });
  }

  async function notifyFailure(event: InboundEvent, log: Logger) {
    try {
      await options.onFailure?.(event);
    } catch (error) {
      log.warn("failure_notice_failed", errorFields(error));
    }
  }

  async function process(event: InboundEvent, raw: unknown, claimed: boolean) {
    const log = logger.child({ eventId: event.eventId, chatId: event.chatId, kind: event.kind });
    const started = Date.now();

    if (!claimed) {
      const payload = JSON.stringify(raw);
      if (utf8Bytes(payload) > AGENT_EVENT_PAYLOAD_MAX_BYTES) {
        log.warn("event_too_large");
        await notifyFailure(event, log);
        return;
      }
      try {
        const { status } = await service.agentEvents.claim({ channel, eventId: event.eventId, payload });
        if (status === "duplicate") {
          log.info("event_duplicate");
          return;
        }
      } catch (error) {
        // Not stored, so not recoverable: tell the user to resend.
        log.error("event_claim_failed", errorFields(error));
        await notifyFailure(event, log);
        return;
      }
    }

    try {
      await setStatus(event, "processing");
    } catch (error) {
      // conflict: already finished; not_found: purged. Either way there's nothing to do.
      if (isFinanceError(error, "conflict", "not_found")) {
        log.info("event_already_settled", errorFields(error));
        return;
      }
      log.error("event_status_failed", { ...errorFields(error), status: "processing" });
      return; // Left as received: the next recovery pass retries it.
    }

    try {
      await handle(event);
    } catch (error) {
      log.error("event_failed", { ...errorFields(error), ms: Date.now() - started });
      await notifyFailure(event, log);
      try {
        await setStatus(event, "failed", failureCode(error));
      } catch (statusError) {
        log.error("event_status_failed", { ...errorFields(statusError), status: "failed" });
      }
      return;
    }

    // A missed `done` means recovery handles the event again (a duplicate reply), so retry once.
    for (let attempt = 1; ; attempt++) {
      try {
        await setStatus(event, "done");
        break;
      } catch (error) {
        if (isFinanceError(error, "conflict", "not_found")) break;
        if (attempt >= 2) {
          log.error("event_status_failed", { ...errorFields(error), status: "done" });
          return;
        }
      }
    }
    log.info("event_done", { ms: Date.now() - started });
  }

  function enqueue(event: InboundEvent, raw: unknown, claimed: boolean): DeliverResult {
    const result = queues.enqueue(`${channel}:${event.chatId}`, async () => {
      try {
        await process(event, raw, claimed);
      } finally {
        inFlight.delete(event.eventId);
      }
    });
    if (result === "accepted") {
      inFlight.add(event.eventId);
      return "accepted";
    }
    const fields = { eventId: event.eventId, chatId: event.chatId, kind: event.kind, queued: queues.size };
    if (result === "chat_full") {
      // One chat flooding: drop its excess instead of stalling everyone else.
      logger.warn("chat_queue_full", fields);
      return "dropped";
    }
    logger.warn("queue_full", fields);
    return "overloaded";
  }

  return {
    get size() {
      return queues.size;
    },

    deliver(raw) {
      if (!accepting) return "overloaded";
      const event = adapter.parse(raw);
      if (!event || (options.accept && !options.accept(event))) {
        logger.debug("event_ignored", event ? { eventId: event.eventId, kind: event.kind } : {});
        return "ignored";
      }
      return enqueue(event, raw, false);
    },

    async recover({ olderThanSeconds }) {
      let found = 0;
      let queued = 0;
      for (let page = 0; page < RECOVER_MAX_PAGES && accepting; page++) {
        const { items } = await service.agentEvents.listRecoverable({
          channel,
          olderThanSeconds,
          maxAttempts: RECOVER_MAX_ATTEMPTS,
          limit: RECOVER_PAGE,
        });
        found += items.length;
        let queuedThisPage = 0;
        for (const item of items) {
          if (inFlight.has(item.eventId)) continue;
          let event: InboundEvent | null = null;
          try {
            event = adapter.parse(JSON.parse(item.payload));
          } catch {
            event = null;
          }
          if (!event || event.eventId !== item.eventId) {
            logger.warn("recover_unparseable", { eventId: item.eventId });
            try {
              await service.agentEvents.updateStatus({ channel, eventId: item.eventId, status: "failed", error: "unparseable" });
            } catch (error) {
              logger.warn("event_status_failed", { ...errorFields(error), eventId: item.eventId, status: "failed" });
            }
            continue;
          }
          if (enqueue(event, null, true) !== "accepted") break;
          queuedThisPage += 1;
        }
        queued += queuedThisPage;
        // The list has no cursor: a short page is the end, and a page of only queued events would repeat.
        if (items.length < RECOVER_PAGE || queuedThisPage === 0) break;
      }
      if (found > 0) logger.info("recover_queued", { found, queued });
      return queued;
    },

    available: () => queues.available(),

    waitForCapacity: () => queues.waitForCapacity(),

    async shutdown(timeoutMs) {
      accepting = false;
      const drained = await queues.drain(timeoutMs);
      logger.info("pipeline_drained", { drained, remaining: queues.size });
      return drained;
    },
  };
}
