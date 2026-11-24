import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cashflowQuery, netWorthQuery, recentTransactionsQuery, spendingByCategoryQuery, transactionSummaryQuery } from "./dashboard";
import { queryKeys } from "./keys";
import { transactionsSearchQuery, transferQuery } from "./ledger";
import { useApiMutation } from "./mutations";

/** The API over a stubbed `fetch`: every write answers `data`, unless `fail` says otherwise. */
const requests: Array<{ url: string; key: string | null }> = [];
let answers: Array<() => Response> = [];
const ok = (data: unknown) => () => Response.json({ result: { data } });
const apiError = (apiCode: string, httpStatus: number) => () =>
  Response.json({ error: { message: apiCode, code: -32600, data: { apiCode, httpStatus } } }, { status: httpStatus });
const networkError = () => {
  throw new TypeError("Failed to fetch");
};

beforeEach(() => {
  requests.length = 0;
  answers = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), key: new Headers(init.headers).get("Idempotency-Key") });
    return (answers.shift() ?? ok({}))();
  });
});
afterEach(() => vi.unstubAllGlobals());

function setup<G extends Parameters<typeof useApiMutation>[0]>(group: G, op: string, retry: boolean | number = false) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry, retryDelay: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const { result } = renderHook(() => useApiMutation(group, op as never), { wrapper });
  return { result, keys: () => invalidate.mock.calls.map(([filters]) => filters?.queryKey) };
}

const input = { name: "Food", type: "expense", icon: "utensils", color: "#163300" } as never;

describe("useApiMutation", () => {
  it("sends the same Idempotency-Key when a failed submit is retried, a new one after success", async () => {
    const { result } = setup("categories", "create");
    answers = [networkError, ok({ category: {} }), ok({ category: {} })];
    await act(() => result.current.mutateAsync(input).catch(() => undefined));
    await act(() => result.current.mutateAsync(input));
    await act(() => result.current.mutateAsync(input));
    const [first, retry, next] = requests.map((r) => r.key);
    expect(requests[0]?.url).toContain("/api/trpc/categories.create");
    expect(first).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(retry).toBe(first);
    expect(next).not.toBe(first);
  });

  it("keeps the key across React Query's own retries", async () => {
    const { result } = setup("categories", "create", 1);
    answers = [networkError, ok({ category: {} })];
    await act(() => result.current.mutateAsync(input));
    expect(requests).toHaveLength(2);
    expect(requests[1]?.key).toBe(requests[0]?.key);
  });

  it("invalidates what the write changes, only on success", async () => {
    const { result, keys } = setup("categories", "create");
    answers = [apiError("validation_failed", 400)];
    await act(() => result.current.mutateAsync(input).catch(() => undefined));
    expect(keys()).toEqual([]);
    await act(() => result.current.mutateAsync(input));
    await waitFor(() => expect(keys()).toEqual([queryKeys.categories.all()]));
  });

  it("invalidates on not_found too: the record is already gone", async () => {
    const { result, keys } = setup("categories", "delete");
    answers = [apiError("not_found", 404)];
    await act(() => result.current.mutateAsync({ id: "c1" } as never).catch(() => undefined));
    await waitFor(() => expect(keys()).toEqual([queryKeys.categories.all(), queryKeys.subcategories.all(), queryKeys.transactions.all(), queryKeys.transfers.all(), queryKeys.reports.all()]));
  });

  const ledgerWrite = [queryKeys.accounts.all(), queryKeys.transactions.all(), queryKeys.transfers.all(), queryKeys.reports.all()];

  it.each([
    ["transactions", "create"],
    ["transactions", "update"],
    ["transactions", "delete"],
    ["transfers", "create"],
    ["transfers", "update"],
    ["transfers", "delete"],
    ["accounts", "adjust"],
  ] as const)("%s.%s refreshes balances, transaction lists, transfers and reports", async (group, op) => {
    const { result, keys } = setup(group, op);
    await act(() => result.current.mutateAsync({ id: "t1" } as never));
    await waitFor(() => expect(keys()).toEqual(ledgerWrite));
  });

  it("a goal contribution and a debt payment refresh their own lists, balances, transactions and reports", async () => {
    const contribution = setup("goalContributions", "add");
    await act(() => contribution.result.current.mutateAsync({ goalId: "g1" } as never));
    await waitFor(() => expect(contribution.keys()).toEqual([queryKeys.goalContributions.all(), queryKeys.goals.all(), ...ledgerWrite]));
    const payment = setup("debtPayments", "record");
    await act(() => payment.result.current.mutateAsync({ debtId: "d1" } as never));
    await waitFor(() => expect(payment.keys()).toEqual([queryKeys.debtPayments.all(), queryKeys.debts.all(), ...ledgerWrite]));
  });
});

describe("query keys", () => {
  const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) => JSON.stringify(key[0]).startsWith(JSON.stringify(prefix[0]).slice(0, -1));

  it("keep every ledger and dashboard read under a prefix some write invalidates", () => {
    expect(startsWith(transactionsSearchQuery({ q: "x" }).queryKey, queryKeys.transactions.all())).toBe(true);
    expect(startsWith(recentTransactionsQuery("2026-01").queryKey, queryKeys.transactions.all())).toBe(true);
    expect(startsWith(transferQuery("t1").queryKey, queryKeys.transfers.all())).toBe(true);
    for (const options of [transactionSummaryQuery("2026-01"), spendingByCategoryQuery("2026-01"), cashflowQuery("2026-01", 6), netWorthQuery()]) {
      expect(startsWith(options.queryKey, queryKeys.reports.all())).toBe(true);
    }
    expect(startsWith(queryKeys.reports.debtSummary(), queryKeys.reports.all())).toBe(true);
  });
});
