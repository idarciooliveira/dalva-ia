import { describe, expect, it } from "vitest";

import { currencyCodeSchema, isoDateSchema, linkCodeSchema, monthSchema } from "./primitives";

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

describe("linkCodeSchema", () => {
  it("accepts Telegram start-param safe codes up to 64 chars", () => {
    expect(linkCodeSchema.safeParse("A".repeat(43)).success).toBe(true);
    expect(linkCodeSchema.safeParse("a".repeat(64)).success).toBe(true);
  });

  it("rejects short, long and unsafe codes", () => {
    for (const bad of ["short", "a".repeat(65), "has space in it here", "a+b/c=d".repeat(4), "é".repeat(20)]) {
      expect(linkCodeSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});
