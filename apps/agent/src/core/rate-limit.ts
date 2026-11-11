export interface RateLimiterOptions {
  /** Allowed events per key within `windowMs`. */
  limit: number;
  windowMs: number;
  now?: () => number;
}

export interface RateLimiter {
  /** Count one event for `key`; false (and not counted) when the key is over its limit. */
  take(key: string): boolean;
  /** Keys tracked right now. */
  readonly size: number;
}

/** In-memory sliding window per key. Per process: a restart resets it, which is fine for a cost guard. */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? Date.now;
  const hits = new Map<string, number[]>();
  let lastSweep = now();

  const sweep = (at: number) => {
    // Drop idle keys at most once per window so memory follows active users only.
    if (at - lastSweep < options.windowMs) return;
    lastSweep = at;
    for (const [key, times] of hits) if (times.every((t) => at - t >= options.windowMs)) hits.delete(key);
  };

  return {
    take(key) {
      const at = now();
      sweep(at);
      const recent = (hits.get(key) ?? []).filter((t) => at - t < options.windowMs);
      if (recent.length >= options.limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(at);
      hits.set(key, recent);
      return true;
    },
    get size() {
      return hits.size;
    },
  };
}
