/**
 * The agent's runtime config, read from the API (`instance.agentConfig`,
 * service key): the bot token, webhook secret, bot username and delivery
 * mode, and the AI provider, model and key. The instance owner edits them in
 * the web app; the agent picks a change up without a restart:
 *
 * - every `intervalMs` (15s), and
 * - on demand (`refresh`): a webhook with an unknown secret (the owner just
 *   saved a new bot) or one that arrives before a bot is configured.
 *
 * On-demand loads are throttled (`minRefreshMs`) and coalesced, so a flood of
 * bad webhook calls costs at most one API call per window. A failed load keeps
 * the last config. Listeners run, in order, after each load that changed it.
 */
import { createHash } from "node:crypto";

import { errorFields, type Logger } from "../log";
import type { FinanceOutputs } from "./finance";

export type RemoteConfig = FinanceOutputs["instance"]["agentConfig"];
export type TelegramConfig = NonNullable<RemoteConfig["telegram"]>;
export type AiConfig = NonNullable<RemoteConfig["ai"]>;

export interface ConfigSourceOptions {
  load: () => Promise<RemoteConfig>;
  logger: Logger;
  /** Default 15s. */
  intervalMs?: number;
  /** On-demand refreshes within this window of the last load reuse it. Default 2s. */
  minRefreshMs?: number;
  /** Gets the secrets of every loaded config, for log scrubbing. */
  onSecrets?: (secrets: string[]) => void;
  now?: () => number;
}

export interface ConfigSource {
  /** The last loaded config; null until a load succeeded. */
  readonly current: RemoteConfig | null;
  /** Load now, unless one ran within `minRefreshMs`. Never throws. */
  refresh(): Promise<RemoteConfig | null>;
  onChange(listener: (config: RemoteConfig) => void | Promise<void>): void;
  /** The next load notifies the listeners even if nothing changed (applying it failed elsewhere). */
  invalidate(): void;
  start(): void;
  stop(): void;
}

const fingerprint = (config: RemoteConfig) => createHash("sha256").update(JSON.stringify(config)).digest("hex");

export function createConfigSource(options: ConfigSourceOptions): ConfigSource {
  const intervalMs = options.intervalMs ?? 15_000;
  const minRefreshMs = options.minRefreshMs ?? 2_000;
  const now = options.now ?? Date.now;
  const listeners: Array<(config: RemoteConfig) => void | Promise<void>> = [];
  let current: RemoteConfig | null = null;
  let currentPrint: string | null = null;
  let lastLoadAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<RemoteConfig | null> | null = null;
  let failing = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function load(): Promise<RemoteConfig | null> {
    let next: RemoteConfig;
    try {
      next = await options.load();
    } catch (error) {
      // Once per outage, not every interval.
      if (!failing) options.logger.warn("config_load_failed", errorFields(error));
      failing = true;
      return current;
    } finally {
      lastLoadAt = now();
    }
    if (failing) options.logger.info("config_load_recovered");
    failing = false;
    options.onSecrets?.(
      [next.telegram?.token, next.telegram?.webhookSecret, next.ai?.apiKey].filter((value): value is string => typeof value === "string"),
    );
    const print = fingerprint(next);
    if (print === currentPrint) return current;
    current = next;
    currentPrint = print;
    options.logger.info("config_changed", {
      telegram: next.telegram ? next.telegram.delivery : "unconfigured",
      bot: next.telegram?.botUsername,
      aiProvider: next.ai?.provider ?? "unconfigured",
      model: next.ai?.model,
    });
    for (const listener of listeners) {
      try {
        await listener(next);
      } catch (error) {
        options.logger.error("config_apply_failed", errorFields(error));
        // Applied again on the next load, though it hasn't changed.
        currentPrint = null;
      }
    }
    return current;
  }

  function refresh(force = false): Promise<RemoteConfig | null> {
    if (inflight) return inflight;
    if (!force && now() - lastLoadAt < minRefreshMs) return Promise.resolve(current);
    inflight = load().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    get current() {
      return current;
    },
    refresh: () => refresh(false),
    onChange(listener) {
      listeners.push(listener);
    },
    invalidate() {
      currentPrint = null;
    },
    start() {
      if (timer) return;
      timer = setInterval(() => void refresh(true), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
