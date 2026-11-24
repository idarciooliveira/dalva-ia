import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { dashboardKeys } from "./dashboard";
import { queryKeys } from "./keys";
import { ledgerKeys } from "./ledger";
import { useApiMutation } from "./mutations";

const write = vi.fn().mockResolvedValue({});
vi.mock("./client", () => ({
  api: new Proxy({}, { get: () => new Proxy({}, { get: () => (...args: unknown[]) => write(...args) }) }),
}));

const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) => prefix.every((part, i) => key[i] === part);

describe("ledger invalidation", () => {
  it.each([
    ["transactions", "create"],
    ["transactions", "update"],
    ["transactions", "delete"],
    ["transfers", "create"],
    ["transfers", "update"],
    ["transfers", "delete"],
  ] as const)("%s.%s refreshes balances, transaction lists and reports", async (group, op) => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useApiMutation(group, op), { wrapper });
    await act(() => result.current.mutateAsync({ id: "t1" } as never));

    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      queryKeys.accounts.all(),
      queryKeys.transactions.all(),
      queryKeys.reports.all(),
    ]);
  });

  it("keeps every ledger and dashboard key under a prefix some write invalidates", () => {
    expect(startsWith(ledgerKeys.search({ q: "x" }), queryKeys.transactions.all())).toBe(true);
    expect(startsWith(ledgerKeys.transfer("t1"), queryKeys.transactions.all())).toBe(true);
    expect(startsWith(dashboardKeys.recent("2026-01"), queryKeys.transactions.all())).toBe(true);
    for (const key of [
      dashboardKeys.summary("2026-01"),
      dashboardKeys.spending("2026-01"),
      dashboardKeys.cashflow("2026-01", 6),
      dashboardKeys.netWorth(),
    ]) {
      expect(startsWith(key, queryKeys.reports.all())).toBe(true);
    }
  });
});
