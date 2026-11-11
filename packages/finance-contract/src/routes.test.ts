import { describe, expect, it } from "vitest";

import {
  allRoutes,
  buildRequestParts,
  isWriteRoute,
  matchRoute,
  mergeRequestInput,
  pathParamNames,
  requiresIdempotencyKey,
  routes,
} from "./routes";

describe("route map", () => {
  it("covers every v1 operation", () => {
    const names = allRoutes().map((r) => r.name).sort();
    expect(names).toEqual(
      [
        "accounts.adjust",
        "accounts.get",
        "accounts.list",
        "categories.list",
        "channelIdentities.resolve",
        "channelIdentities.unlink",
        "channelLinks.redeem",
        "debtPayments.list",
        "debtPayments.record",
        "debtPayments.remove",
        "debts.get",
        "debts.list",
        "goalContributions.add",
        "goalContributions.list",
        "goalContributions.remove",
        "goals.get",
        "goals.list",
        "reports.cashflow",
        "reports.debtSummary",
        "reports.netWorth",
        "reports.spendingByCategory",
        "reports.transactionSummary",
        "subcategories.list",
        "transactions.create",
        "transactions.delete",
        "transactions.search",
        "transactions.update",
        "transfers.create",
        "transfers.delete",
        "transfers.update",
      ].sort(),
    );
  });

  it("has unique method+path pairs", () => {
    const keys = allRoutes().map((r) => `${r.route.method} ${r.route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only mutates through POST/PATCH/DELETE and reads through GET", () => {
    for (const { name, route } of allRoutes().filter((r) => r.route.auth === "user")) {
      const read = name.endsWith(".list") || name.endsWith(".get") || name.endsWith(".search") || name.startsWith("reports.");
      expect(route.method === "GET", name).toBe(read);
      expect(isWriteRoute(route), name).toBe(!read);
    }
  });

  it("marks only the channel routes as service routes, one auth per group", () => {
    const service = allRoutes().filter((r) => r.route.auth === "service").map((r) => r.name).sort();
    expect(service).toEqual(["channelIdentities.resolve", "channelIdentities.unlink", "channelLinks.redeem"]);
    for (const ops of Object.values(routes)) {
      expect(new Set(Object.values(ops).map((r) => r.auth)).size).toBe(1);
    }
  });

  it("requires an Idempotency-Key on user writes only", () => {
    expect(requiresIdempotencyKey(routes.transactions.create)).toBe(true);
    expect(requiresIdempotencyKey(routes.transactions.search)).toBe(false);
    expect(requiresIdempotencyKey(routes.channelLinks.redeem)).toBe(false);
    expect(requiresIdempotencyKey(routes.channelIdentities.unlink)).toBe(false);
  });

  it("declares every path param in the request schema", () => {
    for (const { name, route } of allRoutes()) {
      const shape = (route.request as unknown as { shape: Record<string, unknown> }).shape;
      for (const param of pathParamNames(route.path)) {
        expect(shape, `${name} :${param}`).toHaveProperty(param);
      }
    }
  });
});

describe("matchRoute", () => {
  it("matches static and parameterised paths under /api/v1", () => {
    expect(matchRoute("GET", "/api/v1/accounts")?.name).toBe("accounts.list");
    expect(matchRoute("GET", "/api/v1/accounts/abc")).toMatchObject({ name: "accounts.get", params: { id: "abc" } });
    expect(matchRoute("POST", "/api/v1/debts/d1/payments")).toMatchObject({
      name: "debtPayments.record",
      params: { debtId: "d1" },
    });
    expect(matchRoute("GET", "/api/v1/reports/cashflow")?.name).toBe("reports.cashflow");
  });

  it("tolerates a trailing slash and decodes params", () => {
    expect(matchRoute("GET", "/api/v1/accounts/")?.name).toBe("accounts.list");
    expect(matchRoute("GET", "/api/v1/accounts/a%20b")?.params).toEqual({ id: "a b" });
  });

  it("returns null for unknown paths, wrong methods and other prefixes", () => {
    expect(matchRoute("GET", "/api/v1/nope")).toBeNull();
    expect(matchRoute("DELETE", "/api/v1/accounts")).toBeNull();
    expect(matchRoute("GET", "/api/v2/accounts")).toBeNull();
    expect(matchRoute("GET", "/accounts")).toBeNull();
    expect(matchRoute("GET", "/api/v1/accounts/a/b")).toBeNull();
    expect(matchRoute("GET", "/api/v1")).toBeNull();
  });

  it("rejects empty path segments and keeps encoded slashes inside one param", () => {
    expect(matchRoute("GET", "/api/v1//accounts")).toBeNull();
    expect(matchRoute("GET", "/api/v1/accounts//a")).toBeNull();
    expect(matchRoute("GET", "/api/v1/accounts/a%2Fb")?.params).toEqual({ id: "a/b" });
    expect(matchRoute("GET", "/api/v1/accounts/%E0%A4%A")).toBeNull();
  });
});

describe("buildRequestParts", () => {
  it("splits GET input into path and query", () => {
    const parts = buildRequestParts(routes.transactions.search, { accountId: "a1", limit: 10, q: undefined });
    expect(parts.path).toBe("/transactions");
    expect(parts.query).toBe("accountId=a1&limit=10");
    expect(parts.body).toBeUndefined();
  });

  it("puts path params in the path and the rest in the body for writes", () => {
    const parts = buildRequestParts(routes.transactions.update, { id: "t/1", note: "hi" });
    expect(parts.path).toBe("/transactions/t%2F1");
    expect(parts.query).toBe("");
    expect(parts.body).toEqual({ note: "hi" });
  });

  it("sends no body for deletes", () => {
    const parts = buildRequestParts(routes.transactions.delete, { id: "t1" });
    expect(parts.path).toBe("/transactions/t1");
    expect(parts.body).toBeUndefined();
  });
});

describe("mergeRequestInput", () => {
  it("merges query or body with path params, path params winning", () => {
    const match = matchRoute("GET", "/api/v1/debts/d1/payments")!;
    expect(mergeRequestInput(match, new URLSearchParams("debtId=evil&x=1"))).toEqual({ debtId: "d1", x: "1" });
    expect(mergeRequestInput(match, { note: "n", debtId: "evil" })).toEqual({ note: "n", debtId: "d1" });
    expect(mergeRequestInput(match, undefined)).toEqual({ debtId: "d1" });
  });

  it("feeds the request schema end to end", () => {
    const match = matchRoute("GET", "/api/v1/transactions")!;
    const input = mergeRequestInput(match, new URLSearchParams("limit=5&type=income"));
    expect(match.route.request.parse(input)).toEqual({ limit: 5, type: "income" });
  });
});
