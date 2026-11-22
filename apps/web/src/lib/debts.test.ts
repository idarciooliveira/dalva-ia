import { describe, expect, it } from "vitest";

import { debtPercentPaid, parseInterestRate, splitPayment } from "./debts";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

describe("debtPercentPaid", () => {
  it("is the paid share of the original amount, clamped", () => {
    expect(debtPercentPaid({ originalAmount: usd(250000), currentBalance: usd(200000) })).toBe(20);
    expect(debtPercentPaid({ originalAmount: usd(100), currentBalance: usd(0) })).toBe(100);
    expect(debtPercentPaid({ originalAmount: usd(0), currentBalance: usd(0) })).toBe(0);
    // Legacy rows can hold more than the original amount.
    expect(debtPercentPaid({ originalAmount: usd(100), currentBalance: usd(150) })).toBe(0);
  });
});

describe("splitPayment", () => {
  it("is all principal when both are blank", () => {
    expect(splitPayment(15000, null, null)).toEqual({ principal: 15000, interest: 0 });
  });

  it("fills a blank part with the rest of the payment", () => {
    expect(splitPayment(15000, 12000, null)).toEqual({ principal: 12000, interest: 3000 });
    expect(splitPayment(15000, null, 3000)).toEqual({ principal: 12000, interest: 3000 });
  });

  it("takes both when they add up, and refuses them otherwise", () => {
    expect(splitPayment(15000, 12000, 3000)).toEqual({ principal: 12000, interest: 3000 });
    expect(splitPayment(15000, 12000, 1000)).toEqual({ error: "Principal and interest must add up to the payment amount" });
    expect(splitPayment(15000, 16000, null)).toHaveProperty("error");
    expect(splitPayment(15000, null, 16000)).toHaveProperty("error");
  });
});

describe("parseInterestRate", () => {
  it("takes a dot or a comma, blank as null", () => {
    expect(parseInterestRate("24.99")).toBe(24.99);
    expect(parseInterestRate("5,5")).toBe(5.5);
    expect(parseInterestRate(" ")).toBeNull();
    expect(parseInterestRate("1.2.3")).toBeNaN();
    expect(parseInterestRate(".")).toBeNaN();
  });
});
