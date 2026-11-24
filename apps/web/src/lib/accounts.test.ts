import { describe, expect, it } from "vitest";

import { accountsForBaseCurrency } from "./accounts";

const account = (id: string, type: string, currency: string) => ({ id, type, balance: { amountMinor: 0, currency } });

describe("accountsForBaseCurrency", () => {
  const accounts = [
    account("usd-bank", "bank", "USD"),
    account("eur-bank", "bank", "EUR"),
    account("usd-card", "credit_card", "USD"),
    account("usd-savings", "savings", "USD"),
  ];

  it("keeps only base-currency accounts and counts the others", () => {
    const { usable, otherCurrency } = accountsForBaseCurrency(accounts, "USD");
    expect(usable.map((a) => a.id)).toEqual(["usd-bank", "usd-card", "usd-savings"]);
    expect(otherCurrency).toBe(1);
  });

  it("narrows by type before counting", () => {
    expect(accountsForBaseCurrency(accounts, "USD", ["savings", "bank"])).toEqual({
      usable: [accounts[0], accounts[3]],
      otherCurrency: 1,
    });
    expect(accountsForBaseCurrency(accounts, "USD", ["credit_card", "loan"]).otherCurrency).toBe(0);
  });
});
