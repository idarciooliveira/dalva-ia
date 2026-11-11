import { API_BASE_PATH } from "@mpf/finance-contract";

export type Reachability = "ok" | "unreachable";

export interface FinanceProbeOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Cache a result this long, so a busy health endpoint doesn't hammer the API. */
  cacheMs?: number;
  now?: () => number;
}

/**
 * Cheap reachability check: an unauthenticated GET on the API base. Any HTTP
 * answer (even 401/404) means the API is up. No credentials are sent.
 */
export function createFinanceProbe(options: FinanceProbeOptions): () => Promise<Reachability> {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const timeoutMs = options.timeoutMs ?? 2000;
  const cacheMs = options.cacheMs ?? 15_000;
  const now = options.now ?? Date.now;
  let cached: { at: number; value: Reachability } | null = null;
  let inflight: Promise<Reachability> | null = null;

  return async () => {
    if (cached && now() - cached.at < cacheMs) return cached.value;
    inflight ??= (async () => {
      let value: Reachability;
      try {
        const response = await doFetch(`${options.baseUrl}${API_BASE_PATH}`, {
          method: "GET",
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.body?.cancel();
        value = response.status < 500 ? "ok" : "unreachable";
      } catch {
        value = "unreachable";
      }
      cached = { at: now(), value };
      inflight = null;
      return value;
    })();
    return inflight;
  };
}
