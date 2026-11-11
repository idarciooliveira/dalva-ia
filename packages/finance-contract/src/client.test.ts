import { describe, expect, it, vi } from "vitest";

import { createFinanceClient, createFinanceServiceClient, FinanceApiError } from "./client";

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

/** Mimics fetch: rejects with `signal.reason` as soon as (or if already) aborted. */
const hangUntilAborted = (async (_: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason));
  })) as typeof fetch;

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

  it("rejects ids that could escape the path", async () => {
    const { client, fetchMock } = setup(() => json({ ok: true, data: {} }));
    for (const id of ["..", ".", "a/b", "a%2Fb", "", "a b"]) {
      await expect(client.accounts.get({ id })).rejects.toMatchObject({ code: "validation_failed", status: null });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles a baseUrl with a path prefix and trailing slash", async () => {
    const calls: string[] = [];
    const client = createFinanceClient({
      baseUrl: "https://host.test/finance//",
      getToken: () => "t",
      fetch: (async (url: RequestInfo | URL) => {
        calls.push(String(url));
        return json({ ok: true, data: { items: [] } });
      }) as typeof fetch,
    });
    await client.accounts.list();
    expect(calls).toEqual(["https://host.test/finance/api/v1/accounts"]);
  });

  it("tolerates extra fields in responses (additive evolution)", async () => {
    const { client } = setup(() =>
      json({
        ok: true,
        data: { items: [{ ...accountJson, balance: { ...usd(1), formatted: "$0.01" }, newField: 1 }], extra: true },
      }),
    );
    const { items } = await client.accounts.list();
    expect(items[0]?.balance.amountMinor).toBe(1);
  });

  it("encodes path params and applies request defaults", async () => {
    const { client, calls } = setup(() => json({ ok: true, data: { items: [], nextCursor: null } }));
    await client.transactions.search({ q: "coffee & tea" });
    expect(calls[0]!.url).toBe("https://api.example.test/api/v1/transactions?q=coffee+%26+tea&limit=25");

    const { client: c2, calls: calls2 } = setup(() => json({ ok: true, data: { account: accountJson } }));
    await c2.accounts.get({ id: "a_b-1" });
    expect(calls2[0]!.url).toBe("https://api.example.test/api/v1/accounts/a_b-1");
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

  it("keeps the server message and raw code for an error code it does not know", async () => {
    const err = await setup(() =>
      json({ ok: false, error: { code: "payload_too_large", message: "Body too big", details: { max: 1 } } }, 413),
    ).client.accounts
      .list()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "invalid_response",
      status: 413,
      message: "Body too big",
      details: { serverCode: "payload_too_large", details: { max: 1 } },
    });
  });

  it("honours an error envelope even on a 2xx status", async () => {
    const err = await setup(() => json({ ok: false, error: { code: "conflict", message: "dup" } }, 200)).client.accounts
      .list()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "conflict", status: 200, message: "dup" });
  });

  it("exposes the idempotency key on failed writes so they can be retried", async () => {
    const client = createFinanceClient({
      baseUrl: "https://api.example.test",
      getToken: () => "t",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
      generateIdempotencyKey: () => "generated-key-1",
    });
    const input = { type: "expense", amount: usd(100), accountId: "a", date: "2026-04-05" } as const;
    expect(await client.transactions.create(input).catch((e: unknown) => e)).toMatchObject({
      code: "network_error",
      idempotencyKey: "generated-key-1",
    });
    expect(await client.transactions.create(input, { idempotencyKey: "caller-key-001" }).catch((e: unknown) => e)).toMatchObject({
      idempotencyKey: "caller-key-001",
    });
    // reads have no key
    expect(await client.accounts.list().catch((e: unknown) => e)).toMatchObject({ idempotencyKey: undefined });
  });

  it("also attaches the key to server errors on writes", async () => {
    const { client } = setup(() => json({ ok: false, error: { code: "conflict", message: "key reused" } }, 409));
    const err = await client.transactions
      .delete({ id: "t1" }, { idempotencyKey: "caller-key-002" })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "conflict", idempotencyKey: "caller-key-002" });
  });

  it("reports caller cancellation as `aborted` and a timeout as `timeout`, keeping the cause", async () => {
    const controller = new AbortController();
    const client = createFinanceClient({ baseUrl: "https://api.example.test", getToken: () => "t", fetch: hangUntilAborted });

    const pending = client.accounts.list(undefined, { signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    const aborted = await pending;
    expect(aborted).toBeInstanceOf(FinanceApiError);
    expect(aborted).toMatchObject({ code: "aborted", status: null, details: { causeName: "AbortError" } });
    expect(((aborted as FinanceApiError).cause as Error).name).toBe("AbortError");

    const timedOut = await client.accounts
      .list(undefined, { signal: AbortSignal.timeout(10) })
      .catch((e: unknown) => e);
    expect(timedOut).toBeInstanceOf(FinanceApiError);
    expect(timedOut).toMatchObject({ code: "timeout", status: null, details: { causeName: "TimeoutError" } });
    expect(((timedOut as FinanceApiError).cause as Error).name).toBe("TimeoutError");
  });

  it("tells abort, timeout and network failure apart", async () => {
    const networkDown = createFinanceClient({
      baseUrl: "https://api.example.test",
      getToken: () => "t",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const codes = [
      ((await networkDown.accounts.list().catch((e: unknown) => e)) as FinanceApiError).code,
      ((await createFinanceClient({ baseUrl: "https://x.test", getToken: () => "t", fetch: hangUntilAborted }).accounts
        .list(undefined, { signal: AbortSignal.abort() })
        .catch((e: unknown) => e)) as FinanceApiError).code,
      ((await createFinanceClient({ baseUrl: "https://x.test", getToken: () => "t", fetch: hangUntilAborted }).accounts
        .list(undefined, { signal: AbortSignal.timeout(5) })
        .catch((e: unknown) => e)) as FinanceApiError).code,
    ];
    expect(codes).toEqual(["network_error", "aborted", "timeout"]);
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

describe("edge cases", () => {
  const input = { type: "expense", amount: usd(100), accountId: "a", date: "2026-04-05" } as const;

  it("keeps the idempotency key on an aborted or timed-out write", async () => {
    const client = createFinanceClient({
      baseUrl: "https://api.example.test",
      getToken: () => "t",
      fetch: hangUntilAborted,
      generateIdempotencyKey: () => "generated-key-2",
    });
    const err = await client.transactions
      .create(input, { signal: AbortSignal.timeout(10) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FinanceApiError);
    expect(err).toMatchObject({ code: "timeout", idempotencyKey: "generated-key-2" });
  });

  it("gives concurrent writes on one shared aborted signal their own error and key", async () => {
    let n = 0;
    const client = createFinanceClient({
      baseUrl: "https://api.example.test",
      getToken: async () => "t",
      fetch: hangUntilAborted,
      generateIdempotencyKey: () => `generated-key-${++n}`,
    });
    const controller = new AbortController();
    const calls = [
      client.transactions.create(input, { signal: controller.signal }),
      client.transactions.create({ ...input, note: "second" }, { signal: controller.signal }),
      client.transactions.delete({ id: "t1" }, { signal: controller.signal, idempotencyKey: "caller-key-003" }),
    ].map((p) => p.then(() => undefined, (e: unknown) => e as FinanceApiError));
    controller.abort();
    const [a, b, c] = await Promise.all(calls);

    expect([a?.idempotencyKey, b?.idempotencyKey, c?.idempotencyKey]).toEqual([
      "generated-key-1",
      "generated-key-2",
      "caller-key-003",
    ]);
    expect(new Set([a, b, c]).size).toBe(3);
    // all three wrap the very same reason, which is left untouched
    expect(a?.cause).toBe(controller.signal.reason);
    expect(b?.cause).toBe(controller.signal.reason);
    expect(Object.keys(controller.signal.reason as object)).not.toContain("idempotencyKey");
  });

  it("still reports the key when the abort reason is frozen or not an Error", async () => {
    const client = createFinanceClient({
      baseUrl: "https://api.example.test",
      getToken: () => "t",
      fetch: hangUntilAborted,
      generateIdempotencyKey: () => "generated-key-9",
    });

    const frozen = new AbortController();
    frozen.abort(Object.freeze(new Error("stop")));
    const a = await client.transactions.create(input, { signal: frozen.signal }).catch((e: unknown) => e);
    expect(a).toBeInstanceOf(FinanceApiError);
    expect(a).toMatchObject({ code: "aborted", idempotencyKey: "generated-key-9", details: { causeName: "Error" } });
    expect((a as FinanceApiError).cause).toBe(frozen.signal.reason);
    expect(Object.isFrozen(frozen.signal.reason)).toBe(true);

    const primitive = new AbortController();
    primitive.abort("because");
    const b = await client.transactions.create(input, { signal: primitive.signal }).catch((e: unknown) => e);
    expect(b).toMatchObject({ code: "aborted", idempotencyKey: "generated-key-9", cause: "because" });
  });

  it("reports a token that cannot be sent as a header as a FinanceApiError", async () => {
    const client = createFinanceClient({
      baseUrl: "https://api.example.test",
      getToken: () => "bad\ntoken",
      fetch: (async () => json({})) as typeof fetch,
    });
    await expect(client.accounts.list()).rejects.toBeInstanceOf(FinanceApiError);
  });

  it("falls back to random hex keys when crypto.randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    try {
      const { client, calls } = setup(() => json({ ok: true, data: { transaction: transactionJson } }));
      await client.transactions.create(input);
      expect(calls[0]!.headers.get("idempotency-key")).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("service client", () => {
  const identity = {
    id: "ci1",
    channel: "telegram",
    externalUserId: "42",
    chatId: "42",
    scopes: ["finance:read", "finance:write"],
    linkedAt: "2026-11-11T10:00:00.000Z",
    consentAt: "2026-11-11T09:59:00.000Z",
  };

  function serviceSetup(respond: (req: Request) => Response) {
    const calls: Request[] = [];
    const service = createFinanceServiceClient({
      baseUrl: "https://api.example.test",
      getServiceKey: () => "svc_key",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        calls.push(req);
        return respond(req);
      }) as typeof fetch,
    });
    return { service, calls };
  }

  it("sends the service key as bearer and no Idempotency-Key", async () => {
    const { service, calls } = serviceSetup(() => json({ ok: true, data: { identity } }));
    const result = await service.channelLinks.redeem({
      channel: "telegram",
      code: "A".repeat(43),
      externalUserId: "42",
      chatId: "42",
    });
    expect(result.identity.id).toBe("ci1");
    const req = calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.example.test/api/v1/channel-links/redeem");
    expect(req.headers.get("authorization")).toBe("Bearer svc_key");
    expect(req.headers.get("idempotency-key")).toBeNull();
  });

  it("maps not_found from resolve", async () => {
    const { service } = serviceSetup(() =>
      json({ ok: false, error: { code: "not_found", message: "Channel identity not found" } }, 404),
    );
    await expect(
      service.channelIdentities.resolve({ channel: "telegram", externalUserId: "42", chatId: "42" }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("exposes only service routes, and the user client only user routes", () => {
    const { service } = serviceSetup(() => json({}));
    expect(Object.keys(service).sort()).toEqual(["channelIdentities", "channelLinks"]);
    const user = createFinanceClient({ baseUrl: "https://x.test", getToken: () => "t" });
    expect(user).not.toHaveProperty("channelLinks");
    expect(user).not.toHaveProperty("channelIdentities");
    expect(user).toHaveProperty("transactions");
  });
});
