import { describe, expect, it } from "vitest";

import type { AccountId } from "./primitives";
import {
  accountIdSchema,
  currencyCodeSchema,
  isoDateSchema,
  moneyInputSchema,
  moneySchema,
  monthSchema,
  nonZeroMoneySchema,
  positiveMoneySchema,
  transactionIdSchema,
} from "./primitives";

describe("ids", () => {
  it("accepts opaque non-empty strings", () => {
    expect(accountIdSchema.parse("k57abc123")).toBe("k57abc123");
  });

  it("rejects empty, non-string and oversized ids", () => {
    expect(accountIdSchema.safeParse("").success).toBe(false);
    expect(accountIdSchema.safeParse(42).success).toBe(false);
    expect(accountIdSchema.safeParse("x".repeat(129)).success).toBe(false);
  });

  it.each([".", "..", "a/b", "a\\b", "a%2Fb", "a b", "a?b", "a#b", "é"])("rejects path-unsafe id %j", (id) => {
    expect(accountIdSchema.safeParse(id).success).toBe(false);
  });

  it("accepts Convex-style ids", () => {
    expect(accountIdSchema.safeParse("jd7f3k9x2m8n4p5q6r7s8t9v0w1y2z3a").success).toBe(true);
  });

  it("is branded at the type level only", () => {
    const id = transactionIdSchema.parse("t1");
    // @ts-expect-error a transaction id is not an account id
    const wrong: AccountId = id;
    expect(wrong).toBe("t1");
  });
});

describe("isoDateSchema", () => {
  it.each(["2026-04-05", "2024-02-29", "2000-02-29", "1999-12-31"])("accepts %s", (d) => {
    expect(isoDateSchema.safeParse(d).success).toBe(true);
  });

  it.each(["2026-4-5", "2026-13-01", "2026-00-10", "2026-04-31", "2023-02-29", "1900-02-29", "2026-04-05T10:00:00Z", "", "05/04/2026", "2026-04-00"])(
    "rejects %j",
    (d) => {
      expect(isoDateSchema.safeParse(d).success).toBe(false);
    },
  );
});

describe("monthSchema", () => {
  it("accepts YYYY-MM only", () => {
    expect(monthSchema.safeParse("2026-04").success).toBe(true);
    expect(monthSchema.safeParse("2026-12").success).toBe(true);
    expect(monthSchema.safeParse("2026-13").success).toBe(false);
    expect(monthSchema.safeParse("2026-00").success).toBe(false);
    expect(monthSchema.safeParse("2026-4").success).toBe(false);
    expect(monthSchema.safeParse("2026-04-01").success).toBe(false);
  });
});

describe("currencyCodeSchema", () => {
  it("accepts three uppercase letters", () => {
    expect(currencyCodeSchema.safeParse("USD").success).toBe(true);
    expect(currencyCodeSchema.safeParse("AOA").success).toBe(true);
  });

  it.each(["usd", "US", "USDD", "U1D", "", " USD"])("rejects %j", (c) => {
    expect(currencyCodeSchema.safeParse(c).success).toBe(false);
  });
});

describe("money schemas", () => {
  it("accepts integer minor units with a currency", () => {
    expect(moneySchema.parse({ amountMinor: -1234, currency: "USD" })).toEqual({
      amountMinor: -1234,
      currency: "USD",
    });
  });

  it.each([
    { amountMinor: 12.5, currency: "USD" },
    { amountMinor: Number.NaN, currency: "USD" },
    { amountMinor: Number.POSITIVE_INFINITY, currency: "USD" },
    { amountMinor: 2 ** 53, currency: "USD" },
    { amountMinor: "1234", currency: "USD" },
    { amountMinor: 1, currency: "usd" },
    { amountMinor: 1 },
    { currency: "USD" },
  ])("rejects %j", (value) => {
    expect(moneySchema.safeParse(value).success).toBe(false);
  });

  it("tolerates extra keys in responses but not in requests", () => {
    const withExtra = { amountMinor: 1, currency: "USD", formatted: "$0.01" };
    expect(moneySchema.safeParse(withExtra).success).toBe(true);
    expect(moneyInputSchema.safeParse(withExtra).success).toBe(false);
    expect(positiveMoneySchema.safeParse(withExtra).success).toBe(false);
    expect(nonZeroMoneySchema.safeParse(withExtra).success).toBe(false);
  });

  it("positive and non-zero variants", () => {
    expect(positiveMoneySchema.safeParse({ amountMinor: 1, currency: "USD" }).success).toBe(true);
    expect(positiveMoneySchema.safeParse({ amountMinor: 0, currency: "USD" }).success).toBe(false);
    expect(positiveMoneySchema.safeParse({ amountMinor: -1, currency: "USD" }).success).toBe(false);
    expect(nonZeroMoneySchema.safeParse({ amountMinor: -1, currency: "USD" }).success).toBe(true);
    expect(nonZeroMoneySchema.safeParse({ amountMinor: 0, currency: "USD" }).success).toBe(false);
  });
});
