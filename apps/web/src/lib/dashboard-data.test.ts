import type { Transaction } from "@/lib/api/types";
import { describe, expect, it } from "vitest";

import { buildRecentTransactions } from "./dashboard-data";

const accounts = new Map([["account-1", "BIC"]]);
const categories = new Map([
  ["category-transport", "Transport"],
  ["category-salary", "Salary"],
]);

/** Contract ids are branded on output; plain strings stand in for them here. */
type Loose<T> = { [K in keyof T]?: T[K] extends infer V ? (V extends string ? string : V) : never };

function transaction(overrides: Loose<Transaction> = {}): Transaction {
  return {
    id: "transaction-1",
    type: "expense",
    amount: { amountMinor: 900, currency: "USD" },
    date: "2026-08-31",
    description: "Taxi",
    accountId: "account-1",
    ...overrides,
  } as Transaction;
}

describe("buildRecentTransactions", () => {
  it("resolves expense and income category names from category IDs", () => {
    const rows = buildRecentTransactions(
      [
        transaction({ categoryId: "category-transport" }),
        transaction({ id: "transaction-2", type: "income", description: "Salary payment", categoryId: "category-salary" }),
      ],
      accounts,
      categories,
    );

    expect(rows.map((item) => item.category)).toEqual(["Transport", "Salary"]);
  });

  it("falls back to Uncategorized when an income or expense has no category", () => {
    const rows = buildRecentTransactions(
      [transaction(), transaction({ id: "transaction-2", type: "income" })],
      accounts,
      categories,
    );

    expect(rows.map((item) => item.category)).toEqual(["Uncategorized", "Uncategorized"]);
  });

  it("keeps adjustment and transfer labels", () => {
    const rows = buildRecentTransactions(
      [transaction({ type: "adjustment" }), transaction({ id: "transaction-2", type: "transfer" })],
      accounts,
      categories,
    );

    expect(rows.map((item) => item.category)).toEqual(["Adjustment", "Transfer"]);
  });

  it("signs amounts by direction and keeps each row's currency", () => {
    const rows = buildRecentTransactions(
      [
        transaction(),
        transaction({ id: "t2", type: "income", amount: { amountMinor: 1500, currency: "JPY" } }),
        transaction({ id: "t3", type: "adjustment", amount: { amountMinor: -200, currency: "USD" } }),
        transaction({ id: "t4", type: "transfer", destinationAccountId: "account-2" }),
        transaction({ id: "t5", type: "transfer", accountId: "gone" }),
      ],
      accounts,
      categories,
    );

    expect(rows.map((r) => [r.amountMinor, r.currency])).toEqual([
      [-900, "USD"],
      [1500, "JPY"],
      [-200, "USD"],
      [-900, "USD"],
      [900, "USD"],
    ]);
    expect(rows[4]!.account).toBe("Unknown account");
  });
});
