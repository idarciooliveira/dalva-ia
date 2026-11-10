import { describe, expect, it } from "vitest";
import * as accounts from "./domain/accounts";
import * as dashboard from "./domain/dashboard";
import * as debts from "./domain/debts";
import { setupTest } from "./test.setup";

const ALICE = "alice-domain";
const BOB = "bob-domain";

describe("domain/dashboard", () => {
  it("computes net worth for the given user only", async () => {
    const t = setupTest();
    await t.run(async (ctx) => {
      await accounts.createAccount(ctx, ALICE, { name: "A", type: "bank", balance: 5000, currency: "EUR" });
      await debts.createDebt(ctx, ALICE, {
        name: "D",
        debtType: "loan",
        originalAmount: 2000,
        currentBalance: 1000,
      });
      await accounts.createAccount(ctx, BOB, { name: "B", type: "bank", balance: 99999, currency: "USD" });
    });

    expect(await t.run((ctx) => dashboard.getNetWorth(ctx, ALICE))).toEqual({
      hasData: true,
      totalAssets: 5000,
      totalDebts: 1000,
      netWorth: 4000,
      currency: "EUR",
    });
  });

  it("reports no data for a user with nothing", async () => {
    const t = setupTest();
    await t.run((ctx) =>
      accounts.createAccount(ctx, BOB, { name: "B", type: "bank", balance: 100, currency: "USD" }),
    );
    expect(await t.run((ctx) => dashboard.getNetWorth(ctx, ALICE))).toMatchObject({
      hasData: false,
      netWorth: 0,
    });
  });
});
