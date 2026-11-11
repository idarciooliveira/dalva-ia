import { routes } from "@mpf/finance-contract";
import { describe, expect, it } from "vitest";

import {
  clientFor,
  expectApiError,
  expectConforms,
  getDoc,
  raw,
  seedAccount,
  seedUser,
  setupApi,
  tokenFor,
  twoUsers,
} from "./test.helpers";

describe("api/v1 accounts", () => {
  it("lists and gets accounts with Money in the account currency", async () => {
    const t = setupApi();
    const { asAlice, aliceAccount, alice } = await twoUsers(t);
    const archived = await seedAccount(t, alice, { name: "Old", currency: "EUR", balance: 5 });
    await t.run((ctx) => ctx.db.patch(archived, { archived: true }));

    const { items } = await asAlice.accounts.list();
    expect(items).toEqual([
      { id: aliceAccount, name: "Checking", type: "bank", balance: { amountMinor: 100_000, currency: "USD" } },
    ]);
    const all = await asAlice.accounts.list({ includeArchived: true });
    expect(all.items.map((a) => a.id)).toEqual([aliceAccount, archived]);

    const { account } = await asAlice.accounts.get({ id: aliceAccount });
    expect(account.balance).toEqual({ amountMinor: 100_000, currency: "USD" });

    const response = await raw(t, "GET", "/accounts?includeArchived=true", { token: await tokenFor(alice) });
    expectConforms(routes.accounts.list, response);
  });

  it("converts balances for 0- and 3-decimal currencies", async () => {
    const t = setupApi();
    const user = await seedUser(t);
    const jpy = await seedAccount(t, user, { currency: "JPY", balance: 123_456 });
    const kwd = await seedAccount(t, user, { currency: "KWD", balance: 1234 });
    const client = clientFor(t, await tokenFor(user));
    expect((await client.accounts.get({ id: jpy })).account.balance).toEqual({ amountMinor: 1235, currency: "JPY" });
    expect((await client.accounts.get({ id: kwd })).account.balance).toEqual({ amountMinor: 12_340, currency: "KWD" });
  });

  it("adjusts a balance, records an adjustment and returns the re-read account", async () => {
    const t = setupApi();
    const { asAlice, aliceAccount } = await twoUsers(t);
    const { account } = await asAlice.accounts.adjust({
      id: aliceAccount,
      amount: { amountMinor: -2_500, currency: "USD" },
      note: "Reconcile",
    });
    expect(account.balance).toEqual({ amountMinor: 97_500, currency: "USD" });

    const { items } = await asAlice.transactions.search({ accountId: aliceAccount });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "adjustment",
      amount: { amountMinor: -2_500, currency: "USD" },
      note: "Reconcile",
      date: new Date().toISOString().slice(0, 10),
    });
  });

  it("adjust uses the given date and converts 3-decimal input", async () => {
    const t = setupApi();
    const user = await seedUser(t);
    const kwd = await seedAccount(t, user, { currency: "KWD", balance: 0 });
    const client = clientFor(t, await tokenFor(user));
    // 1.235 KWD can't be stored exactly (x100): refused, never rounded.
    await expectApiError(client.accounts.adjust({ id: kwd, amount: { amountMinor: 1_235, currency: "KWD" } }), "validation_failed");
    const { account } = await client.accounts.adjust({ id: kwd, amount: { amountMinor: 1_240, currency: "KWD" }, date: "2026-01-02" });
    expect((await getDoc(t, kwd))?.balance).toBe(124);
    expect(account.balance).toEqual({ amountMinor: 1_240, currency: "KWD" });
    const { items } = await client.transactions.search({ accountId: kwd });
    expect(items[0]?.date).toBe("2026-01-02");
  });

  it("rejects a currency mismatch, a zero amount and a malformed id", async () => {
    const t = setupApi();
    const { asAlice, aliceAccount } = await twoUsers(t);
    const error = await expectApiError(
      asAlice.accounts.adjust({ id: aliceAccount, amount: { amountMinor: 100, currency: "EUR" } }),
      "validation_failed",
      400,
    );
    expect(error.details).toEqual({ issues: [{ path: "amount.currency", message: "Currency must be USD, got EUR" }] });
    await expectApiError(asAlice.accounts.adjust({ id: aliceAccount, amount: { amountMinor: 0, currency: "USD" } }), "validation_failed");
    await expectApiError(asAlice.accounts.get({ id: "not-an-id" }), "validation_failed", 400);
    expect((await getDoc(t, aliceAccount))?.balance).toBe(100_000);
  });

  it("isolates users: B cannot read or adjust A's account", async () => {
    const t = setupApi();
    const { asBob, aliceAccount } = await twoUsers(t);
    await expectApiError(asBob.accounts.get({ id: aliceAccount }), "not_found", 404);
    await expectApiError(asBob.accounts.adjust({ id: aliceAccount, amount: { amountMinor: 1, currency: "USD" } }), "not_found", 404);
    expect((await asBob.accounts.list()).items.map((a) => a.id)).not.toContain(aliceAccount);
    expect((await getDoc(t, aliceAccount))?.balance).toBe(100_000);
  });
});
