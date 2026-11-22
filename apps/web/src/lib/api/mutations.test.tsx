import { FinanceApiError } from "@mpf/finance-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { queryKeys } from "./keys";
import { useApiMutation } from "./mutations";

const create = vi.fn();
vi.mock("./client", () => ({ api: { accounts: { create: (...args: unknown[]) => create(...args) } } }));

const input = { name: "Main", type: "bank" as const, balance: { amountMinor: 100, currency: "USD" } };
const account = { id: "a1", name: "Main", type: "bank", balance: { amountMinor: 100, currency: "USD" } };

function setup(retry: boolean | number = false) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry, retryDelay: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const { result } = renderHook(() => useApiMutation("accounts", "create"), { wrapper });
  return { result, invalidate };
}

const keyOf = (call: unknown[]) => (call[1] as { idempotencyKey: string }).idempotencyKey;

describe("useApiMutation", () => {
  beforeEach(() => create.mockReset());

  it("sends the same Idempotency-Key when a failed submit is retried, a new one after success", async () => {
    const { result } = setup();
    create.mockRejectedValueOnce(new FinanceApiError("network_error", "Request failed", null));
    await act(() => result.current.mutateAsync(input).catch(() => undefined));
    create.mockResolvedValue({ account });
    await act(() => result.current.mutateAsync({ ...input }));
    await act(() => result.current.mutateAsync(input));

    const [first, retry, next] = create.mock.calls.map(keyOf);
    expect(first).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(retry).toBe(first);
    expect(next).not.toBe(first);
  });

  it("keeps the key across React Query's own retries", async () => {
    const { result } = setup(1);
    create.mockRejectedValueOnce(new FinanceApiError("network_error", "Request failed", null)).mockResolvedValue({ account });
    await act(() => result.current.mutateAsync(input));
    expect(create).toHaveBeenCalledTimes(2);
    expect(keyOf(create.mock.calls[1]!)).toBe(keyOf(create.mock.calls[0]!));
  });

  it("invalidates what the write changes, only on success", async () => {
    const { result, invalidate } = setup();
    create.mockRejectedValueOnce(new FinanceApiError("validation_failed", "Invalid", 400));
    await act(() => result.current.mutateAsync(input).catch(() => undefined));
    expect(invalidate).not.toHaveBeenCalled();

    create.mockResolvedValue({ account });
    await act(() => result.current.mutateAsync(input));
    await waitFor(() =>
      expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
        queryKeys.accounts.all(),
        queryKeys.reports.all(),
      ]),
    );
  });
});
