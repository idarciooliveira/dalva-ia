import { describe, expect, it, vi } from "vitest";

import { createFinanceClient, FinanceApiError } from "./client";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

const accountJson = { id: "acc1", name: "Main", type: "bank", balance: usd(10000) };
const transactionJson = {
  id: "t1",
  type: "expense",
  amount: usd(1250),
  accountId: "acc1",
  date: "2026-04-05",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup(respond: (req: Request) => Response | Promise<Response>, extra: { getToken?: () => string } = {}) {
  const calls: Request[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req);
    return respond(req);
  });
  const client = createFinanceClient({
    baseUrl: "https://api.example.test/",
    getToken: extra.getToken ?? (() => "tok_123"),
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, calls, fetchMock };
}

describe("reads", () => {
  it("sends bearer auth and query params, and returns the parsed data", async () => {
    const { client, calls } = setup(() => json({ ok: true, data: { items: [accountJson] } }));
    const result = await client.accounts.list({ includeArchived: true });

    expect(result.items[0]?.name).toBe("Main");
    const req = calls[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://api.example.test/api/v1/accounts?includeArchived=true");
    expect(req.headers.get("authorization")).toBe("Bearer tok_123");
    expect(req.headers.get("idempotency-key")).toBeNull();
  });

  it("awaits an async getToken on every call", async () => {
    let n = 0;
    const calls: string[] = [];
    const client = createFinanceClient({
      baseUrl: "https://api.example.test",
      getToken: async () => `tok_${++n}`,
      fetch: (async (_: RequestInfo | URL, init?: RequestInit) => {
        calls.push(new Headers(init?.headers).get("authorization") ?? "");
        return json({ ok: true, data: { items: [] } });
      }) as typeof fetch,
    });
    await client.accounts.list();
    await client.accounts.list();
    expect(calls).toEqual(["Bearer tok_1", "Bearer tok_2"]);
  });

  it("encodes path params and applies request defaults", async () => {
    const { client, calls } = setup(() => json({ ok: true, data: { items: [], nextCursor: null } }));
    await client.transactions.search({ q: "coffee & tea" });
    expect(calls[0]!.url).toBe("https://api.example.test/api/v1/transactions?q=coffee+%26+tea&limit=25");

    const { client: c2, calls: calls2 } = setup(() => json({ ok: true, data: { account: accountJson } }));
    await c2.accounts.get({ id: "a/b" });
    expect(calls2[0]!.url).toBe("https://api.example.test/api/v1/accounts/a%2Fb");
  });

  it("validates input before sending anything", async () => {
    const { client, fetchMock } = setup(() => json({ ok: true, data: {} }));
    const err = await client.transactions.search({ limit: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FinanceApiError);
    expect(err).toMatchObject({ code: "validation_failed", status: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("writes", () => {
  const createInput = {
    type: "expense",
    amount: usd(1250),
    accountId: "acc1",
    date: "2026-04-05",
  } as const;

  it("sends a JSON body and a generated Idempotency-Key", async () => {
    const { client, calls } = setup(() => json({ ok: true, data: { transaction: transactionJson } }));
    const result = await client.transactions.create(createInput);

    expect(result.transaction.id).toBe("t1");
    const req = calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.example.test/api/v1/transactions");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(req.headers.get("idempotency-key")).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(await req.json()).toEqual(createInput);
  });

  it("generates a fresh key per call", async () => {
    const { client, calls } = setup(() => json({ ok: true, data: { transaction: transactionJson } }));
    await client.transactions.create(createInput);
    await client.transactions.create(createInput);
    expect(calls[0]!.headers.get("idempotency-key")).not.toBe(calls[1]!.headers.get("idempotency-key"));
  });

  it("uses the caller's key when given", async () => {
    const { client, calls } = setup(() => json({ ok: true, data: { transaction: transactionJson } }));
    await client.transactions.create(createInput, { idempotencyKey: "my-key-0001" });
    expect(calls[0]!.headers.get("idempotency-key")).toBe("my-key-0001");
  });

  it("rejects a malformed caller key before sending", async () => {
    const { client, fetchMock } = setup(() => json({ ok: true, data: {} }));
    await expect(client.transactions.create(createInput, { idempotencyKey: "short" })).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PATCH carries path param in the URL and the rest in the body", async () => {
    const { client, calls } = setup(() => json({ ok: true, data: { transaction: transactionJson } }));
    await client.transactions.update({ id: "t1", note: "hi" });
    const req = calls[0]!;
    expect(req.method).toBe("PATCH");
    expect(req.url).toBe("https://api.example.test/api/v1/transactions/t1");
    expect(await req.json()).toEqual({ note: "hi" });
    expect(req.headers.get("idempotency-key")).not.toBeNull();
  });

  it("DELETE has an idempotency key and no body", async () => {
    const { client, calls } = setup(() => json({ ok: true, data: { id: "t1" } }));
    await client.transactions.delete({ id: "t1" });
    const req = calls[0]!;
    expect(req.method).toBe("DELETE");
    expect(req.headers.get("idempotency-key")).not.toBeNull();
    expect(req.body).toBeNull();
  });
});

describe("errors", () => {
  it.each([
    ["unauthorized", 401],
    ["forbidden", 403],
    ["not_found", 404],
    ["validation_failed", 400],
    ["conflict", 409],
    ["rate_limited", 429],
    ["internal", 500],
  ] as const)("maps the %s envelope to FinanceApiError", async (code, status) => {
    const { client } = setup(() =>
      json({ ok: false, error: { code, message: `boom ${code}`, details: { issues: [{ path: "x", message: "y" }] } } }, status),
    );
    const err = await client.accounts.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FinanceApiError);
    expect(err).toMatchObject({ code, status, message: `boom ${code}`, details: { issues: [{ path: "x", message: "y" }] } });
  });

  it("flags a 2xx body that does not match the response schema", async () => {
    const { client } = setup(() => json({ ok: true, data: { items: [{ id: "a" }] } }));
    const err = await client.accounts.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FinanceApiError);
    expect(err).toMatchObject({ code: "invalid_response", status: 200 });
  });

  it("flags a 2xx body that is not an envelope or not JSON", async () => {
    const a = await setup(() => json({ items: [] })).client.accounts.list().catch((e: unknown) => e);
    expect(a).toMatchObject({ code: "invalid_response", status: 200 });
    const b = await setup(() => new Response("<html>", { status: 200 })).client.accounts.list().catch((e: unknown) => e);
    expect(b).toMatchObject({ code: "invalid_response", status: 200 });
  });

  it("flags a non-2xx response without an envelope, keeping the status", async () => {
    const err = await setup(() => new Response("Bad gateway", { status: 502 })).client.accounts
      .list()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("flags an error envelope with an unknown code", async () => {
    const err = await setup(() => json({ ok: false, error: { code: "teapot", message: "x" } }, 418)).client.accounts
      .list()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "invalid_response", status: 418 });
  });

  it("wraps network failures", async () => {
    const client = createFinanceClient({
      baseUrl: "https://api.example.test",
      getToken: () => "t",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const err = await client.accounts.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FinanceApiError);
    expect(err).toMatchObject({ code: "network_error", status: null });
  });

  it("does not wrap a failing getToken as an API error", async () => {
    const client = createFinanceClient({
      baseUrl: "https://api.example.test",
      getToken: () => {
        throw new Error("no token");
      },
      fetch: (async () => json({})) as typeof fetch,
    });
    await expect(client.accounts.list()).rejects.toThrow("no token");
  });
});

describe("types", () => {
  it("requires input where the route has required fields", () => {
    const { client } = setup(() => json({ ok: true, data: {} }));
    // Compile-time only: never invoked.
    const typeChecks = () => {
      // @ts-expect-error id is required
      void client.accounts.get();
      // @ts-expect-error unknown operation
      void client.accounts.nope;
      // @ts-expect-error amount must be Money, not a number
      void client.transfers.create({ amount: 5, fromAccountId: "a", toAccountId: "b", date: "2026-04-05" });
      void client.accounts.list();
      void client.reports.netWorth();
    };
    expect(typeof typeChecks).toBe("function");
  });
});
