import { describe, expect, it } from "vitest";

import {
  accountSchema,
  accountsListRequestSchema,
  cashflowRequestSchema,
  debtPaymentRecordRequestSchema,
  goalContributionAddRequestSchema,
  transactionCreateRequestSchema,
  transactionSchema,
  transactionsSearchRequestSchema,
  transactionUpdateRequestSchema,
  transferCreateRequestSchema,
  transferUpdateRequestSchema,
  accountAdjustRequestSchema,
} from "./schemas";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

describe("transactionCreateRequestSchema", () => {
  const base = { type: "expense", amount: usd(1250), accountId: "acc1", date: "2026-04-05" };

  it("accepts a minimal expense and a full income", () => {
    expect(transactionCreateRequestSchema.safeParse(base).success).toBe(true);
    expect(
      transactionCreateRequestSchema.safeParse({
        ...base,
        type: "income",
        categoryId: "cat1",
        subcategoryId: "sub1",
        description: "Salary",
        note: "April",
        payee: "ACME",
      }).success,
    ).toBe(true);
  });

  it("rejects zero or negative income/expense", () => {
    expect(transactionCreateRequestSchema.safeParse({ ...base, amount: usd(0) }).success).toBe(false);
    expect(transactionCreateRequestSchema.safeParse({ ...base, amount: usd(-5) }).success).toBe(false);
  });

  it("allows signed non-zero adjustments but not zero", () => {
    const adj = { ...base, type: "adjustment" };
    expect(transactionCreateRequestSchema.safeParse({ ...adj, amount: usd(-500) }).success).toBe(true);
    expect(transactionCreateRequestSchema.safeParse({ ...adj, amount: usd(500) }).success).toBe(true);
    expect(transactionCreateRequestSchema.safeParse({ ...adj, amount: usd(0) }).success).toBe(false);
  });

  it("rejects category or subcategory on adjustments (domain rule)", () => {
    const adj = { ...base, type: "adjustment" };
    expect(transactionCreateRequestSchema.safeParse({ ...adj, categoryId: "c" }).success).toBe(false);
    expect(transactionCreateRequestSchema.safeParse({ ...adj, subcategoryId: "s" }).success).toBe(false);
  });

  it("rejects type=transfer (use the transfers endpoints)", () => {
    expect(transactionCreateRequestSchema.safeParse({ ...base, type: "transfer" }).success).toBe(false);
  });

  it("rejects bad dates, floats, missing fields and unknown keys", () => {
    expect(transactionCreateRequestSchema.safeParse({ ...base, date: "2026-02-30" }).success).toBe(false);
    expect(transactionCreateRequestSchema.safeParse({ ...base, amount: usd(12.5) }).success).toBe(false);
    expect(transactionCreateRequestSchema.safeParse({ ...base, accountId: undefined }).success).toBe(false);
    expect(transactionCreateRequestSchema.safeParse({ ...base, userId: "u1" }).success).toBe(false);
  });
});

describe("transactionUpdateRequestSchema", () => {
  it("requires at least one field besides id", () => {
    expect(transactionUpdateRequestSchema.safeParse({ id: "t1" }).success).toBe(false);
    expect(transactionUpdateRequestSchema.safeParse({ id: "t1", note: "x" }).success).toBe(true);
  });

  it("rejects a zero amount and type=transfer", () => {
    expect(transactionUpdateRequestSchema.safeParse({ id: "t1", amount: usd(0) }).success).toBe(false);
    expect(transactionUpdateRequestSchema.safeParse({ id: "t1", type: "transfer" }).success).toBe(false);
  });

  it("rejects switching to adjustment with a category in the same request", () => {
    expect(
      transactionUpdateRequestSchema.safeParse({ id: "t1", type: "adjustment", categoryId: "c" }).success,
    ).toBe(false);
  });
});

describe("transfers", () => {
  const base = { amount: usd(5000), fromAccountId: "a", toAccountId: "b", date: "2026-04-05" };

  it("accepts a valid transfer", () => {
    expect(transferCreateRequestSchema.safeParse(base).success).toBe(true);
  });

  it("rejects same-account and non-positive transfers", () => {
    expect(transferCreateRequestSchema.safeParse({ ...base, toAccountId: "a" }).success).toBe(false);
    expect(transferCreateRequestSchema.safeParse({ ...base, amount: usd(0) }).success).toBe(false);
    expect(transferCreateRequestSchema.safeParse({ ...base, amount: usd(-1) }).success).toBe(false);
  });

  it("update needs a field and rejects same-account when both are given", () => {
    expect(transferUpdateRequestSchema.safeParse({ id: "t" }).success).toBe(false);
    expect(transferUpdateRequestSchema.safeParse({ id: "t", note: "n" }).success).toBe(true);
    expect(
      transferUpdateRequestSchema.safeParse({ id: "t", fromAccountId: "a", toAccountId: "a" }).success,
    ).toBe(false);
  });
});

describe("transactionsSearchRequestSchema", () => {
  it("defaults limit to 25", () => {
    expect(transactionsSearchRequestSchema.parse({}).limit).toBe(25);
  });

  it("bounds limit to 1..100", () => {
    for (const limit of [0, 101, -1, 1.5]) {
      expect(transactionsSearchRequestSchema.safeParse({ limit }).success).toBe(false);
    }
    expect(transactionsSearchRequestSchema.parse({ limit: 100 }).limit).toBe(100);
    expect(transactionsSearchRequestSchema.parse({ limit: 1 }).limit).toBe(1);
  });

  it("coerces query-string values", () => {
    const parsed = transactionsSearchRequestSchema.parse({ limit: "10", type: "expense", q: "coffee" });
    expect(parsed).toMatchObject({ limit: 10, type: "expense", q: "coffee" });
    expect(transactionsSearchRequestSchema.safeParse({ limit: "abc" }).success).toBe(false);
    expect(transactionsSearchRequestSchema.safeParse({ limit: "-5" }).success).toBe(false);
  });

  it("rejects inverted date ranges, bad dates and unknown filters", () => {
    expect(
      transactionsSearchRequestSchema.safeParse({ dateFrom: "2026-05-01", dateTo: "2026-04-01" }).success,
    ).toBe(false);
    expect(
      transactionsSearchRequestSchema.safeParse({ dateFrom: "2026-04-01", dateTo: "2026-04-01" }).success,
    ).toBe(true);
    expect(transactionsSearchRequestSchema.safeParse({ dateFrom: "yesterday" }).success).toBe(false);
    expect(transactionsSearchRequestSchema.safeParse({ categoryID: "x" }).success).toBe(false);
  });
});

describe("query coercion", () => {
  it("parses includeArchived from strings and booleans", () => {
    expect(accountsListRequestSchema.parse({ includeArchived: "true" })).toEqual({ includeArchived: true });
    expect(accountsListRequestSchema.parse({ includeArchived: "false" })).toEqual({ includeArchived: false });
    expect(accountsListRequestSchema.parse({ includeArchived: true })).toEqual({ includeArchived: true });
    expect(accountsListRequestSchema.safeParse({ includeArchived: "yes" }).success).toBe(false);
  });

  it("cashflow trendMonths is bounded and defaulted", () => {
    expect(cashflowRequestSchema.parse({ month: "2026-04" }).trendMonths).toBe(6);
    expect(cashflowRequestSchema.safeParse({ month: "2026-04", trendMonths: 0 }).success).toBe(false);
    expect(cashflowRequestSchema.safeParse({ month: "2026-04", trendMonths: 25 }).success).toBe(false);
    expect(cashflowRequestSchema.safeParse({ month: "2026-4" }).success).toBe(false);
  });
});

describe("goal contributions and balance adjustments", () => {
  it("contribution amount must be positive", () => {
    const base = { goalId: "g", amount: usd(100), date: "2026-04-05" };
    expect(goalContributionAddRequestSchema.safeParse(base).success).toBe(true);
    expect(goalContributionAddRequestSchema.safeParse({ ...base, fromAccountId: "a" }).success).toBe(true);
    expect(goalContributionAddRequestSchema.safeParse({ ...base, amount: usd(-100) }).success).toBe(false);
  });

  it("adjustment is signed, non-zero", () => {
    expect(accountAdjustRequestSchema.safeParse({ id: "a", amount: usd(-100) }).success).toBe(true);
    expect(accountAdjustRequestSchema.safeParse({ id: "a", amount: usd(0) }).success).toBe(false);
  });
});

describe("debtPaymentRecordRequestSchema", () => {
  const base = { debtId: "d", fromAccountId: "a", date: "2026-04-05", amount: usd(10000) };

  it("defaults principal to the full amount and interest to zero (domain behaviour)", () => {
    expect(debtPaymentRecordRequestSchema.safeParse(base).success).toBe(true);
    expect(
      debtPaymentRecordRequestSchema.safeParse({ ...base, principalAmount: usd(9000), interestAmount: usd(1000) })
        .success,
    ).toBe(true);
    expect(debtPaymentRecordRequestSchema.safeParse({ ...base, principalAmount: usd(10000) }).success).toBe(true);
  });

  it("requires principal + interest to equal the amount", () => {
    expect(
      debtPaymentRecordRequestSchema.safeParse({ ...base, principalAmount: usd(9000), interestAmount: usd(500) })
        .success,
    ).toBe(false);
    // interest alone: principal defaults to the full amount, so the sum overshoots
    expect(debtPaymentRecordRequestSchema.safeParse({ ...base, interestAmount: usd(1000) }).success).toBe(false);
  });

  it("allows zero interest or zero principal but not negatives", () => {
    expect(
      debtPaymentRecordRequestSchema.safeParse({ ...base, principalAmount: usd(0), interestAmount: usd(10000) })
        .success,
    ).toBe(true);
    expect(
      debtPaymentRecordRequestSchema.safeParse({ ...base, principalAmount: usd(11000), interestAmount: usd(-1000) })
        .success,
    ).toBe(false);
  });

  it("rejects mixed currencies and non-positive amounts", () => {
    expect(
      debtPaymentRecordRequestSchema.safeParse({
        ...base,
        principalAmount: { amountMinor: 10000, currency: "EUR" },
      }).success,
    ).toBe(false);
    expect(debtPaymentRecordRequestSchema.safeParse({ ...base, amount: usd(0) }).success).toBe(false);
  });
});

describe("response models", () => {
  it("accepts transactions as the domain stores them (optional fields omitted)", () => {
    expect(
      transactionSchema.safeParse({
        id: "t1",
        type: "expense",
        amount: usd(1250),
        accountId: "a1",
        date: "2026-04-05",
      }).success,
    ).toBe(true);
  });

  it("accepts every account type and rejects unknown ones", () => {
    const account = { id: "a", name: "Main", balance: usd(-5), type: "bank" };
    for (const type of ["bank", "savings", "credit_card", "cash", "e_wallet", "loan", "investment"]) {
      expect(accountSchema.safeParse({ ...account, type }).success).toBe(true);
    }
    expect(accountSchema.safeParse({ ...account, type: "crypto" }).success).toBe(false);
  });
});
