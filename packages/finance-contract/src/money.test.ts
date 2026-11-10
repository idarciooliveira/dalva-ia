import { describe, expect, it } from "vitest";

import {
  currencyExponent,
  formatMinorAmount,
  MoneyError,
  moneyFromDecimal,
  parseDecimalAmount,
} from "./money";

describe("currencyExponent", () => {
  it("knows 0, 2 and 3 decimal currencies", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("AOA")).toBe(2);
    expect(currencyExponent("KWD")).toBe(3);
  });

  it("rejects malformed codes", () => {
    expect(() => currencyExponent("usd")).toThrow(MoneyError);
    expect(() => currencyExponent("US")).toThrow(MoneyError);
  });
});

describe("parseDecimalAmount", () => {
  it.each([
    ["1500", "JPY", 1500],
    ["1500.4", "JPY", 1500],
    ["1500.5", "JPY", 1501],
    ["12", "USD", 1200],
    ["12.3", "USD", 1230],
    ["12.34", "USD", 1234],
    ["0.07", "USD", 7],
    ["+5.00", "USD", 500],
    ["1.2", "KWD", 1200],
    ["1.234", "KWD", 1234],
  ])("parses %s %s -> %d", (input, currency, expected) => {
    expect(parseDecimalAmount(input, currency)).toBe(expected);
  });

  it("does not go through floats", () => {
    // 1.005 * 100 === 100.49999999999999 and 0.29 * 100 === 28.999999999999996
    expect(parseDecimalAmount("1.005", "USD")).toBe(101);
    expect(parseDecimalAmount("0.29", "USD")).toBe(29);
    expect(parseDecimalAmount("19.99", "USD")).toBe(1999);
    expect(parseDecimalAmount("90071992547409.91", "USD")).toBe(9007199254740991);
  });

  it("rounds half away from zero on the first dropped digit", () => {
    expect(parseDecimalAmount("12.345", "USD")).toBe(1235);
    expect(parseDecimalAmount("12.344", "USD")).toBe(1234);
    expect(parseDecimalAmount("12.3449", "USD")).toBe(1234);
    expect(parseDecimalAmount("-12.345", "USD")).toBe(-1235);
    expect(parseDecimalAmount("-12.344", "USD")).toBe(-1234);
    expect(parseDecimalAmount("1.2345", "KWD")).toBe(1235);
    expect(parseDecimalAmount("0.004", "USD")).toBe(0);
    expect(parseDecimalAmount("0.005", "USD")).toBe(1);
  });

  it("handles negatives and never returns -0", () => {
    expect(parseDecimalAmount("-12.34", "USD")).toBe(-1234);
    expect(parseDecimalAmount("-0", "USD")).toBe(0);
    expect(Object.is(parseDecimalAmount("-0.001", "USD"), 0)).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    expect(parseDecimalAmount("  12.34 ", "USD")).toBe(1234);
  });

  it.each(["", " ", "abc", "1,5", "1,000.00", "1.2.3", "1e3", ".5", "5.", "--1", "+-1", "1 000", "NaN", "Infinity", "$5", "5€"])(
    "rejects malformed input %j",
    (input) => {
      expect(() => parseDecimalAmount(input, "USD")).toThrow(MoneyError);
    },
  );

  it("rejects amounts beyond the safe integer range", () => {
    expect(() => parseDecimalAmount("9007199254740993", "JPY")).toThrow(MoneyError);
    expect(() => parseDecimalAmount("90071992547409.92", "USD")).toThrow(MoneyError);
    expect(() => parseDecimalAmount("-90071992547409.92", "USD")).toThrow(MoneyError);
  });

  it("rejects malformed currency codes", () => {
    expect(() => parseDecimalAmount("1", "usd")).toThrow(MoneyError);
  });
});

describe("formatMinorAmount", () => {
  it.each([
    [1234, "USD", "12.34"],
    [5, "USD", "0.05"],
    [0, "USD", "0.00"],
    [-5, "USD", "-0.05"],
    [-1234, "USD", "-12.34"],
    [1500, "JPY", "1500"],
    [-1500, "JPY", "-1500"],
    [1234, "KWD", "1.234"],
    [7, "KWD", "0.007"],
    [9007199254740991, "USD", "90071992547409.91"],
  ])("formats %d %s -> %s", (minor, currency, expected) => {
    expect(formatMinorAmount(minor, currency)).toBe(expected);
  });

  it("rejects non-integer and unsafe values", () => {
    expect(() => formatMinorAmount(12.5, "USD")).toThrow(MoneyError);
    expect(() => formatMinorAmount(Number.NaN, "USD")).toThrow(MoneyError);
    expect(() => formatMinorAmount(2 ** 53, "USD")).toThrow(MoneyError);
  });

  it("round-trips with parseDecimalAmount", () => {
    for (const currency of ["JPY", "USD", "KWD"]) {
      for (const minor of [0, 1, 9, 10, 99, 100, 101, 12345, -1, -101, -987654]) {
        expect(parseDecimalAmount(formatMinorAmount(minor, currency), currency)).toBe(minor);
      }
    }
  });
});

describe("moneyFromDecimal", () => {
  it("builds a Money value", () => {
    expect(moneyFromDecimal("12.34", "USD")).toEqual({ amountMinor: 1234, currency: "USD" });
  });
});

describe("currency exponent table", () => {
  it("follows ISO 4217 (not CLDR/Intl, which differs for e.g. IQD)", () => {
    for (const code of ["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]) {
      expect(currencyExponent(code), code).toBe(0);
    }
    for (const code of ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]) {
      expect(currencyExponent(code), code).toBe(3);
    }
    for (const code of ["USD", "EUR", "AOA", "BRL", "GBP", "CHF", "ZAR", "MZN", "CAD"]) {
      expect(currencyExponent(code), code).toBe(2);
    }
  });

  it("falls back to 2 for well-formed codes it does not know", () => {
    expect(currencyExponent("BTC")).toBe(2);
  });
});
