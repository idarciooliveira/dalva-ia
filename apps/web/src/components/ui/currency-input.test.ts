import { describe, expect, it } from "vitest";

import { formatCurrencyInput, parseCurrencyInput } from "./currency-input";

describe("CurrencyInput mask", () => {
  it("formats digits at the currency's precision, keeping a sign only when allowed", () => {
    expect(formatCurrencyInput("150050")).toBe("1.500,50");
    expect(formatCurrencyInput("1500", "pt-BR", 0)).toBe("1.500");
    expect(formatCurrencyInput("-200000", "pt-BR", 2, true)).toBe("-2.000,00");
    expect(formatCurrencyInput("-200000", "pt-BR", 2, false)).toBe("2.000,00");
    expect(formatCurrencyInput("-", "pt-BR", 2, true)).toBe("-");
  });

  it("parses to signed minor units; a lone sign is not an amount", () => {
    expect(parseCurrencyInput("1.500,50")).toBe(150050);
    expect(parseCurrencyInput("-2.000,00")).toBe(-200000);
    expect(parseCurrencyInput("")).toBe(0);
    expect(parseCurrencyInput("-")).toBeNaN();
    expect(parseCurrencyInput("9".repeat(17))).toBeNaN();
  });
});
