import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createTRPCClient, TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { AppRouter } from "@mpf/api/trpc";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { apiErrorMessage, isApiError, isTransientError } from "./errors";
import { queryKeys } from "./keys";
import { useTrpcMutation } from "./mutations";
import { idempotencyLink, trpc } from "./trpc";

/** A client whose last link records each write's key and answers with `answer()`. */
function clientWith(answer: () => unknown) {
  const keys: unknown[] = [];
  const terminal: TRPCLink<AppRouter> = () => ({ op }) =>
    observable((observer) => {
      keys.push(op.context.idempotencyKey);
      try {
        observer.next({ result: { type: "data", data: answer() } });
        observer.complete();
      } catch (error) {
        observer.error(TRPCClientError.from(error as Error));
      }
    });
  return { keys, client: createTRPCClient<AppRouter>({ links: [idempotencyLink(), terminal] }) };
}

const input = { id: "0190a0a0-0000-7000-8000-000000000001", amount: { amountMinor: 1, currency: "USD" } };

describe("idempotencyLink", () => {
  it("reuses a write's key until it succeeds, per procedure and input", async () => {
    let fail = true;
    const { keys, client } = clientWith(() => {
      if (fail) throw new Error("network");
      return { account: {} };
    });
    await client.accounts.adjust.mutate(input).catch(() => undefined);
    fail = false;
    await client.accounts.adjust.mutate({ ...input });
    await client.accounts.adjust.mutate(input);
    await client.accounts.archive.mutate({ id: input.id });
    const [first, retry, next, other] = keys;
    expect(first).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(retry).toBe(first);
    expect(next).not.toBe(first);
    expect(other).not.toBe(next);
  });

  it("keeps a key the caller set, and sends none on reads", async () => {
    const { keys, client } = clientWith(() => ({ items: [] }));
    await client.accounts.adjust.mutate(input, { context: { idempotencyKey: "action-0001" } });
    await client.accounts.list.query();
    expect(keys).toEqual(["action-0001", undefined]);
  });
});

describe("useTrpcMutation", () => {
  it("invalidates what the write changes, only on success", async () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const mutationFn = vi.fn().mockRejectedValueOnce(new Error("nope")).mockResolvedValue({ account: {} });
    const { result } = renderHook(() => useTrpcMutation({ mutationKey: trpc.accounts.adjust.mutationKey(), mutationFn }), { wrapper });

    await act(() => result.current.mutateAsync(input).catch(() => undefined));
    expect(invalidate).not.toHaveBeenCalled();
    await act(() => result.current.mutateAsync(input));
    await waitFor(() =>
      expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
        queryKeys.accounts.all(),
        queryKeys.transactions.all(),
        queryKeys.reports.all(),
      ]),
    );
    // The accounts prefix matches the list queries.
    expect(queryKeys.accounts.list({ includeArchived: true })[0]).toEqual([...queryKeys.accounts.all()[0], "list"]);
  });
});

describe("tRPC errors", () => {
  const trpcError = (data: object | undefined, message = "Account not found") =>
    TRPCClientError.from({ error: { message, code: -32004, data } } as never);

  it("read the v1 code, message and details from error.data", () => {
    const notFound = trpcError({ apiCode: "not_found", httpStatus: 404 });
    expect(isApiError(notFound, "not_found")).toBe(true);
    expect(apiErrorMessage(notFound)).toBe("Account not found");
    const invalid = trpcError({ apiCode: "validation_failed", httpStatus: 400, details: { issues: [{ path: "name", message: "Too long" }] } }, "Request validation failed");
    expect(apiErrorMessage(invalid)).toBe("Too long");
    expect(isTransientError(invalid)).toBe(false);
    expect(isTransientError(trpcError({ apiCode: "internal", httpStatus: 500 }, "Internal error"))).toBe(true);
  });

  it("treat no answer as offline", () => {
    const offline = TRPCClientError.from(new TypeError("Failed to fetch"));
    expect(isApiError(offline, "network_error")).toBe(true);
    expect(isTransientError(offline)).toBe(true);
    expect(apiErrorMessage(offline)).toMatch(/Can't reach DALVA/);
  });
});
