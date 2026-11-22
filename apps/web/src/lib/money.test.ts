import { describe, expect, it } from "vitest";

import { decimalPlaceholder, formatMinor, maskPlaceholder, parseDecimalInput } from "./money";

describe("formatMinor", () => {
  it("uses the currency's minor unit", () => {
    expect(formatMinor(248500, "USD")).toBe("$2,485.00");
    expect(formatMinor(1500, "JPY")).toBe("¥1,500");
    expect(formatMinor(1235, "KWD")).toMatch(/1\.235/);
    expect(formatMinor(-5, "EUR")).toBe("-€0.05");
  });

  it("survives a code Intl rejects", () => {
    expect(formatMinor(1234, "X1")).toBe("X1 12.34");
  });
});

describe("parseDecimalInput", () => {
  it("parses to minor units without rounding", () => {
    expect(parseDecimalInput("12.5", "USD")).toBe(1250);
    expect(parseDecimalInput("-20", "USD")).toBe(-2000);
    expect(parseDecimalInput(".5", "USD")).toBe(50);
    expect(parseDecimalInput("1500", "JPY")).toBe(1500);
    expect(parseDecimalInput("1.005", "KWD")).toBe(1005);
    expect(parseDecimalInput("", "USD")).toBe(0);
    expect(parseDecimalInput(" 3 ", "USD")).toBe(300);
  });

  it("refuses what the API would refuse", () => {
    expect(parseDecimalInput("1.005", "USD")).toBeNull();
    expect(parseDecimalInput("1.5", "JPY")).toBeNull();
    expect(parseDecimalInput("1e3", "USD")).toBeNull();
    expect(parseDecimalInput("-", "USD")).toBeNull();
    expect(parseDecimalInput("1,50", "USD")).toBeNull();
    expect(parseDecimalInput("90071992547409.92", "USD")).toBeNull();
  });
});

describe("placeholders", () => {
  it("follow the currency's precision", () => {
    expect(decimalPlaceholder(2)).toBe("0.00");
    expect(decimalPlaceholder(0)).toBe("0");
    expect(maskPlaceholder(3)).toBe("0,000");
  });
});
