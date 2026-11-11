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
  /** Called when handling failed, to tell the user. Best effort. */
  onFailure?: (event: InboundEvent) => Promise<void>;
  /** Events that pass are claimed and handled; the rest are dropped before anything is stored. */
  accept?: (event: InboundEvent) => boolean;
  /** Pause before retrying an ambiguous claim or status update. */
  retryDelayMs?: number;
}

export interface RecoverOptions {
  /** Only events untouched for this long. 0 on boot; longer than any handling time afterwards. */
  olderThanSeconds: number;
}

export interface Pipeline {
  /**
   * Synchronous: parse, enqueue and start claiming a raw platform event. The
   * caller answers the platform right away; `persisted()` tells when the claim landed.
   */
  deliver(raw: unknown): DeliverResult;
  /** Resolves once every claim started so far has settled (stored, duplicate or given up). */
  persisted(): Promise<void>;
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
/** Claims run ahead of the per-chat queues so an event is stored before it waits. */
const MAX_CONCURRENT_CLAIMS = 16;
const CLAIM_ATTEMPTS = 3;
const RECOVER_PAGE = 50;
const RECOVER_MAX_PAGES = 10;
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
  const claimSlots = new Semaphore(MAX_CONCURRENT_CLAIMS);
  const pendingClaims = new Set<Promise<unknown>>();
  let accepting = true;
  /** Event ids queued or running here (ref-counted: a redelivery can be queued twice). Recovery skips them. */
  const inFlight = new Map<string, number>();

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

  /**
   * Store the event (dedupe + recovery). After an ambiguous failure the claim
   * may have landed, so a `duplicate` on the retry is our own claim, not a redelivery.
   */
  async function claim(event: InboundEvent, raw: unknown, log: Logger): Promise<ClaimOutcome> {
    const payload = JSON.stringify(adapter.storable(raw));
    if (utf8Bytes(payload) > AGENT_EVENT_PAYLOAD_MAX_BYTES) {
      log.warn("event_too_large");
      return "failed";
    }
    let ambiguous = false;
    for (let attempt = 1; ; attempt++) {
      try {
        const { status } = await claimSlots.run(() =>
          service.agentEvents.claim({ channel, eventId: event.eventId, payload }),
        );
        if (status === "duplicate" && ambiguous) {
          log.info("event_claim_settled");
          return "new";
        }
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

  async function process(event: InboundEvent, claimed: Promise<ClaimOutcome> | null) {
    const log = logger.child({ eventId: event.eventId, chatId: event.chatId, kind: event.kind });
    const started = Date.now();

    if (claimed) {
      const outcome = await claimed;
      if (outcome === "duplicate") {
        log.info("event_duplicate");
        return;
      }
      if (outcome === "failed") {
        // Not stored, so not recoverable: tell the user to resend.
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
        await sleep(retryDelayMs);
      }
    }
    log.info("event_done", { ms: Date.now() - started });
  }

  /** `raw` set: a new event, claimed right away. `raw` null: a recovered event, already claimed. */
  function enqueue(event: InboundEvent, raw: unknown | null): DeliverResult {
    let claimed: Promise<ClaimOutcome> | null = null;
    const result = queues.enqueue(`${channel}:${event.chatId}`, async () => {
      try {
        await process(event, claimed);
      } finally {
        const count = (inFlight.get(event.eventId) ?? 1) - 1;
        if (count > 0) inFlight.set(event.eventId, count);
        else inFlight.delete(event.eventId);
      }
    });
    if (result === "accepted") {
      inFlight.set(event.eventId, (inFlight.get(event.eventId) ?? 0) + 1);
      if (raw !== null) {
        // Claim now, not when the chat's turn comes: an acknowledged event must be stored quickly.
        const log = logger.child({ eventId: event.eventId, chatId: event.chatId, kind: event.kind });
        const pending = claim(event, raw, log);
        claimed = pending;
        pendingClaims.add(pending);
        void pending.finally(() => pendingClaims.delete(pending));
      }
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
      return enqueue(event, raw);
    },

    async persisted() {
      await Promise.all([...pendingClaims]);
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
        let full = false;
        for (const item of items) {
          if (!accepting) break; // Shutting down: leave the rest for the next run.
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
          const result = enqueue(event, null);
          if (result === "accepted") queuedThisPage += 1;
          if (result === "overloaded") {
            full = true;
            break;
          }
          // "dropped": that chat is full; its event stays recoverable for the next pass.
        }
        queued += queuedThisPage;
        // No cursor: a short page is the end, and a page with nothing new would repeat itself.
        if (full || items.length < RECOVER_PAGE || queuedThisPage === 0) break;
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
