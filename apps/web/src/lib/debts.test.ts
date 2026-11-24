import { describe, expect, it } from "vitest";

import type { Debt } from "@mpf/finance-contract";

import {
  clearedDebtFields,
  debtChanges,
  type DebtFormFields,
  debtPercentPaid,
  exceedsOriginal,
  parseInterestRate,
  splitPayment,
} from "./debts";

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

describe("debt edits", () => {
  const debt = {
    id: "d1",
    name: "Visa",
    debtType: "credit_card",
    lender: "Chase",
    originalAmount: usd(250000),
    currentBalance: usd(200000),
    interestRate: 24.99,
    minimumPayment: usd(7500),
    dueDate: "2026-05-15",
    linkedAccountId: "a1",
    createdAt: "2026-01-01",
  } as unknown as Debt;
  const form: DebtFormFields = {
    name: "Visa",
    debtType: "credit_card",
    originalAmount: usd(250000),
    currentBalance: usd(200000),
    lender: "Chase",
    interestRate: 24.99,
    minimumPayment: usd(7500),
    dueDate: "2026-05-15",
    linkedAccountId: "a1",
  };

  it("sends only what the user changed, never the balance the dialog opened with", () => {
    expect(debtChanges(debt, form)).toBeNull();
    // A rename while a payment lowered the stored balance elsewhere: the balance stays out.
    expect(debtChanges(debt, { ...form, name: "Visa Gold" })).toEqual({ name: "Visa Gold" });
    expect(Object.entries(debtChanges(debt, { ...form, currentBalance: usd(150000), linkedAccountId: "a2" })!).filter(([, v]) => v !== undefined)).toEqual([
      ["currentBalance", usd(150000)],
      ["linkedAccountId", "a2"],
    ]);
  });

  it("names the fields cleared on the form that the API can't clear", () => {
    expect(clearedDebtFields(debt, form)).toEqual([]);
    expect(clearedDebtFields(debt, { ...form, lender: undefined, dueDate: undefined })).toEqual(["lender", "due date"]);
  });

  it("refuses a balance above the original amount, except on a legacy debt left as it is", () => {
    expect(exceedsOriginal(null, { ...form, currentBalance: usd(300000) })).toBe(true);
    expect(exceedsOriginal(debt, { ...form, currentBalance: usd(300000) })).toBe(true);
    const legacy = { ...debt, originalAmount: usd(80000), currentBalance: usd(100000) } as Debt;
    expect(exceedsOriginal(legacy, { ...form, originalAmount: usd(80000), currentBalance: usd(100000), name: "Renamed" })).toBe(false);
    expect(exceedsOriginal(legacy, { ...form, originalAmount: usd(80000), currentBalance: usd(90000) })).toBe(true);
  });
});
