import type { Transaction } from "@mpf/finance-contract";
import { describe, expect, it } from "vitest";

import { transactionChanges, transferChanges } from "./form-helpers";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

const original = {
  id: "t1",
  type: "expense",
  amount: usd(2_550),
  accountId: "a1",
  categoryId: "food",
  subcategoryId: "groceries",
  date: "2026-01-05",
  description: "Lunch",
  note: "with Bob",
  payee: "Cafe",
} as unknown as Transaction;

const draft = {
  type: "expense" as const,
  amount: usd(2_550),
  accountId: "a1",
  date: "2026-01-05",
  categoryId: "food",
  subcategoryId: "groceries",
  description: "Lunch",
  note: "with Bob",
  payee: "Cafe",
};

describe("transactionChanges", () => {
  it("is empty when nothing changed (whitespace included)", () => {
    expect(transactionChanges(original, { ...draft, description: " Lunch " })).toEqual({});
  });

  it("sends only what changed", () => {
    expect(transactionChanges(original, { ...draft, description: "Dinner", date: "2026-01-06" })).toEqual({
      description: "Dinner",
      date: "2026-01-06",
    });
  });

  it("clears emptied text fields and the subcategory with null", () => {
    expect(transactionChanges(original, { ...draft, note: "", payee: "  ", subcategoryId: "" })).toEqual({
      note: null,
      payee: null,
      subcategoryId: null,
    });
  });

  it("lets a new category drop the subcategory instead of clearing it", () => {
    expect(transactionChanges(original, { ...draft, categoryId: "transport", subcategoryId: "" })).toEqual({
      categoryId: "transport",
    });
  });

  it("carries the amount when the account changes", () => {
    expect(transactionChanges(original, { ...draft, accountId: "a2" })).toEqual({ accountId: "a2", amount: usd(2_550) });
  });
});

describe("transferChanges", () => {
  const transfer = { amount: usd(1_000), fromAccountId: "a1", toAccountId: "a2", date: "2026-01-01", description: "Rent pot" };
  const same = { amount: usd(1_000), fromAccountId: "a1", toAccountId: "a2", date: "2026-01-01", description: "Rent pot", note: "" };

  it("is empty when nothing changed", () => {
    expect(transferChanges(transfer, same)).toEqual({});
  });

  it("clears an emptied description and carries the amount on an account change", () => {
    expect(transferChanges(transfer, { ...same, description: "", toAccountId: "a3" })).toEqual({
      description: null,
      toAccountId: "a3",
      amount: usd(1_000),
    });
  });
});
