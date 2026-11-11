import { describe, expect, it } from "vitest";

import { appToMinor, minorToApp, MoneyRangeError, toMoney } from "./money";

describe("api/v1 money: app (value x 100) <-> ISO minor units", () => {
  it("passes 2-decimal currencies through exactly", () => {
    for (const value of [0, 1, -1, 1234, -98765, Number.MAX_SAFE_INTEGER]) {
      expect(appToMinor(value, "USD")).toBe(value);
      expect(minorToApp(value, "EUR")).toBe(value);
    }
    expect(toMoney(1234, "AOA")).toEqual({ amountMinor: 1234, currency: "AOA" });
  });

  it("0-decimal (JPY): scales down rounding half away from zero, scales up exactly", () => {
    expect(appToMinor(123_456, "JPY")).toBe(1235); // 1234.56 -> 1235
    expect(appToMinor(123_449, "JPY")).toBe(1234);
    expect(appToMinor(150, "JPY")).toBe(2); // 1.50 -> 2
    expect(appToMinor(-150, "JPY")).toBe(-2); // away from zero
    expect(appToMinor(-149, "JPY")).toBe(-1);
    expect(appToMinor(49, "JPY")).toBe(0);
    expect(Object.is(appToMinor(-49, "JPY"), 0)).toBe(true); // no -0
    expect(minorToApp(1235, "JPY")).toBe(123_500);
    expect(minorToApp(-7, "KRW")).toBe(-700);
  });

  it("3-decimal (KWD): scales up exactly, scales down rounding half away from zero", () => {
    expect(appToMinor(1234, "KWD")).toBe(12_340); // 12.34 -> 12.340
    expect(appToMinor(-1, "KWD")).toBe(-10);
    expect(minorToApp(12_345, "KWD")).toBe(1235); // 12.345 -> 12.35
    expect(minorToApp(12_344, "KWD")).toBe(1234);
    expect(minorToApp(-12_345, "KWD")).toBe(-1235);
    expect(minorToApp(5, "BHD")).toBe(1); // 0.005 -> 0.01
    expect(Object.is(minorToApp(-4, "BHD"), 0)).toBe(true);
  });

  it("round-trips 2-decimal amounts and integral 0/3-decimal amounts", () => {
    for (const minor of [0, 1, 999, -12_345]) {
      expect(appToMinor(minorToApp(minor, "JPY"), "JPY")).toBe(minor);
      expect(minorToApp(appToMinor(minor, "KWD"), "KWD")).toBe(minor);
    }
  });

  it("rejects results outside the safe integer range and bad currency codes", () => {
    expect(() => appToMinor(Number.MAX_SAFE_INTEGER, "KWD")).toThrow(MoneyRangeError);
    expect(() => minorToApp(Number.MAX_SAFE_INTEGER, "JPY")).toThrow(MoneyRangeError);
    expect(() => appToMinor(100, "usd")).toThrow();
  });
});
