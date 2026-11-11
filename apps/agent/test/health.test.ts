import { describe, expect, test, vi } from "vitest";

import { createFinanceProbe } from "../src/core/health";

describe("finance probe", () => {
  test("any answer below 500 is reachable; no credentials are sent; results are cached", async () => {
    let now = 0;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 404 }));
    const probe = createFinanceProbe({ baseUrl: "https://finance.test", fetch: fetchMock as unknown as typeof fetch, now: () => now });
    expect(await probe()).toBe("ok");
    expect(await probe()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://finance.test/api/v1");
    expect(new Headers(init?.headers).get("Authorization")).toBeNull();
    now = 60_000;
    await probe();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("network errors and 5xx are unreachable", async () => {
    const down = createFinanceProbe({ baseUrl: "https://x", fetch: (async () => { throw new TypeError("fail"); }) as unknown as typeof fetch });
    expect(await down()).toBe("unreachable");
    const broken = createFinanceProbe({ baseUrl: "https://x", fetch: (async () => new Response("", { status: 502 })) as unknown as typeof fetch });
    expect(await broken()).toBe("unreachable");
  });
});
