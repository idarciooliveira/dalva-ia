import { FinanceApiError } from "@mpf/finance-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { queryKeys } from "./keys";
import { useApiMutation } from "./mutations";

const create = vi.fn();
const addContribution = vi.fn();
const recordPayment = vi.fn();
vi.mock("./client", () => ({
  api: {
    accounts: { create: (...args: unknown[]) => create(...args) },
    goalContributions: { add: (...args: unknown[]) => addContribution(...args) },
    debtPayments: { record: (...args: unknown[]) => recordPayment(...args) },
  },
}));

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

describe("useApiMutation invalidation of goal and debt money movements", () => {
  function render<G extends "goalContributions" | "debtPayments">(group: G, op: G extends "goalContributions" ? "add" : "record") {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useApiMutation(group, op as never), { wrapper });
    return { result, keys: () => invalidate.mock.calls.map(([filters]) => filters?.queryKey) };
  }
  const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

  it("a contribution refreshes goals, balances, transactions and reports", async () => {
    addContribution.mockResolvedValue({ contribution: {} });
    const { result, keys } = render("goalContributions", "add");
    await act(() => result.current.mutateAsync({ goalId: "g1", amount: usd(100), date: "2026-01-01" } as never));
    await waitFor(() =>
      expect(keys()).toEqual([
        queryKeys.goalContributions.all(),
        queryKeys.goals.all(),
        queryKeys.accounts.all(),
        queryKeys.transactions.all(),
        queryKeys.reports.all(),
      ]),
    );
  });

  it("a debt payment refreshes debts, balances, transactions and reports (the debt summary)", async () => {
    recordPayment.mockResolvedValue({ payment: {} });
    const { result, keys } = render("debtPayments", "record");
    await act(() => result.current.mutateAsync({ debtId: "d1", amount: usd(100), date: "2026-01-01", fromAccountId: "a1" } as never));
    await waitFor(() =>
      expect(keys()).toEqual([
        queryKeys.debtPayments.all(),
        queryKeys.debts.all(),
        queryKeys.accounts.all(),
        queryKeys.transactions.all(),
        queryKeys.reports.all(),
      ]),
    );
    expect(queryKeys.reports.debtSummary().slice(0, 2)).toEqual(queryKeys.reports.all());
  });
});
