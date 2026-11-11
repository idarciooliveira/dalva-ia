import { createFinanceClient, createFinanceServiceClient, FinanceApiError } from "@mpf/finance-contract";
import type { FinanceClient, FinanceServiceClient } from "@mpf/finance-contract";

export type { FinanceClient, FinanceServiceClient };

export interface FinanceClients {
  service: FinanceServiceClient;
  /** User client for a token minted by `channelIdentities.resolve`. */
  forToken(token: string): FinanceClient;
}

export interface FinanceClientsOptions {
  baseUrl: string;
  serviceKey: string;
  fetch?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export function createFinanceClients(options: FinanceClientsOptions): FinanceClients {
  const baseFetch: typeof fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const timedFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    baseFetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    })) as typeof fetch;

  return {
    service: createFinanceServiceClient({
      baseUrl: options.baseUrl,
      getServiceKey: () => options.serviceKey,
      fetch: timedFetch,
    }),
    forToken: (token) => createFinanceClient({ baseUrl: options.baseUrl, getToken: () => token, fetch: timedFetch }),
  };
}

export function isFinanceError(error: unknown, ...codes: string[]): error is FinanceApiError {
  return error instanceof FinanceApiError && (codes.length === 0 || codes.includes(error.code));
}
