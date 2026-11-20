import { routes } from "@mpf/finance-contract";
import { describe, expect, it } from "vitest";

import {
  expectApiError,
  expectConforms,
  getAccountRow,
  oneUser,
  raw,
  seedAccount,
  tokenFor,
  transactionRows,
  twoUsers,
} from "../../../test/api";
import { testDb } from "../../../test/db";
import { savingsGoals } from "../../db/schema";

describe("api/v1 accounts", () => {
  it("lists and gets accounts with Money in the account currency", async () => {
    const { app, asAlice, aliceAccount, alice } = await twoUsers();
    const archived = await seedAccount(alice, { name: "Old", currency: "EUR", balance: 5, archived: true });

    const { items } = await asAlice.accounts.list();
    expect(items).toEqual([
      { id: aliceAccount, name: "Checking", type: "bank", balance: { amountMinor: 100_000, currency: "USD" } },
    ]);
    const all = await asAlice.accounts.list({ includeArchived: true });
    expect(all.items.map((a) => a.id)).toEqual([aliceAccount, archived]);
    expect(all.items[1]).toMatchObject({ archived: true, balance: { amountMinor: 5, currency: "EUR" } });

    const { account } = await asAlice.accounts.get({ id: aliceAccount });
    expect(account.balance).toEqual({ amountMinor: 100_000, currency: "USD" });

    const response = await raw(app, "GET", "/accounts?includeArchived=true", { token: await tokenFor(alice) });
    expectConforms(routes.accounts.list, response);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("converts balances for 0- and 3-decimal currencies", async () => {
    const { user, client } = await oneUser();
    const jpy = await seedAccount(user, { currency: "JPY", balance: 123_456 });
    const kwd = await seedAccount(user, { currency: "KWD", balance: 1234 });
    expect((await client.accounts.get({ id: jpy })).account.balance).toEqual({ amountMinor: 1235, currency: "JPY" });
    expect((await client.accounts.get({ id: kwd })).account.balance).toEqual({ amountMinor: 12_340, currency: "KWD" });
  });

  describe("adjust", () => {
    it("adjusts a balance, records an adjustment dated today and returns the account", async () => {
      const { asAlice, aliceAccount } = await twoUsers();
      const { account } = await asAlice.accounts.adjust({
        id: aliceAccount,
        amount: { amountMinor: -2_500, currency: "USD" },
        note: "Reconcile",
      });
      expect(account.balance).toEqual({ amountMinor: 97_500, currency: "USD" });
      expect(await transactionRows()).toEqual([
        expect.objectContaining({
          accountId: aliceAccount,
          type: "adjustment",
          amount: -2_500,
          description: "Balance adjustment",
          note: "Reconcile",
          date: new Date().toISOString().slice(0, 10),
        }),
      ]);
    });

    it("uses the given date and converts 3-decimal input, refusing what x100 storage can't hold", async () => {
      const { user, client } = await oneUser();
      const kwd = await seedAccount(user, { currency: "KWD", balance: 0 });
      // 1.235 KWD can't be stored exactly (x100): refused, never rounded.
      const precision = await expectApiError(
        client.accounts.adjust({ id: kwd, amount: { amountMinor: 1_235, currency: "KWD" } }),
        "validation_failed",
      );
      expect(precision.details).toMatchObject({ reason: "precision" });
      const { account } = await client.accounts.adjust({ id: kwd, amount: { amountMinor: 1_240, currency: "KWD" }, date: "2026-01-02" });
      expect((await getAccountRow(kwd))?.balance).toBe(124);
      expect(account.balance).toEqual({ amountMinor: 1_240, currency: "KWD" });
      expect((await transactionRows())[0]?.date).toBe("2026-01-02");
    });

    it("refuses a balance the contract can't express, and rolls back", async () => {
      const { user, client } = await oneUser();
      // 9e14 KWD x100-stored is past the safe integer range in ISO (x1000) minor units.
      const kwd = await seedAccount(user, { currency: "KWD", balance: 900_000_000_000_000 });
      const error = await expectApiError(
        client.accounts.adjust({ id: kwd, amount: { amountMinor: 1_000_000_000_000_000, currency: "KWD" } }),
        "validation_failed",
        400,
      );
      expect(error.message).toBe("Balance out of range");
      expect((await getAccountRow(kwd))?.balance).toBe(900_000_000_000_000);
      expect(await transactionRows()).toEqual([]);
    });

    it("rejects a currency mismatch, a zero amount and a malformed id", async () => {
      const { asAlice, aliceAccount } = await twoUsers();
      const error = await expectApiError(
        asAlice.accounts.adjust({ id: aliceAccount, amount: { amountMinor: 100, currency: "EUR" } }),
        "validation_failed",
        400,
      );
      expect(error.details).toEqual({ issues: [{ path: "amount.currency", message: "Currency must be USD, got EUR" }] });
      await expectApiError(asAlice.accounts.adjust({ id: aliceAccount, amount: { amountMinor: 0, currency: "USD" } }), "validation_failed");
      await expectApiError(asAlice.accounts.get({ id: "not-an-id" }), "validation_failed", 400);
      expect((await getAccountRow(aliceAccount))?.balance).toBe(100_000);
      expect(await transactionRows()).toEqual([]);
    });
  });

  describe("create, update, archive, restore, delete", () => {
    it("creates an account in the currency of its opening balance", async () => {
      const { user, client } = await oneUser();

      const { account } = await client.accounts.create({
        name: "Wallet",
        type: "cash",
        balance: { amountMinor: 1_240, currency: "KWD" },
        theme: "azul",
      });
      expect(account).toEqual({
        id: account.id,
        name: "Wallet",
        type: "cash",
        balance: { amountMinor: 1_240, currency: "KWD" },
        theme: "azul",
      });
      expect(await getAccountRow(account.id)).toMatchObject({ userId: user, balance: 124, currency: "KWD", archived: false });

      const negative = await client.accounts.create({ name: "Card", type: "credit_card", balance: { amountMinor: -5_000, currency: "USD" } });
      expect(negative.account.balance).toEqual({ amountMinor: -5_000, currency: "USD" });
      await expectApiError(
        client.accounts.create({ name: "Bad", type: "bank", balance: { amountMinor: 1_235, currency: "KWD" } }),
        "validation_failed",
      );
      expect((await client.accounts.list()).items.map((a) => a.name)).toEqual(["Wallet", "Card"]);
    });

    it("supports every account type", async () => {
      const { client } = await oneUser();
      const types = ["bank", "savings", "credit_card", "cash", "e_wallet", "loan", "investment"] as const;
      for (const type of types) {
        await client.accounts.create({ name: `${type} account`, type, balance: { amountMinor: 0, currency: "USD" } });
      }
      expect((await client.accounts.list()).items.map((a) => a.type)).toEqual(types);
    });

    it("updates only the given fields", async () => {
      const { asAlice, aliceAccount } = await twoUsers();
      const { account } = await asAlice.accounts.update({ id: aliceAccount, name: "New Name", type: "savings", theme: "verde", icon: "piggy-bank" });
      expect(account).toEqual({
        id: aliceAccount,
        name: "New Name",
        type: "savings",
        theme: "verde",
        icon: "piggy-bank",
        balance: { amountMinor: 100_000, currency: "USD" },
      });
      const described = await asAlice.accounts.update({ id: aliceAccount, description: "Main" });
      expect(described.account).toMatchObject({ name: "New Name", theme: "verde", description: "Main" });
    });

    it("refuses an update with no field, or with the currency or balance", async () => {
      const { app, alice, aliceAccount } = await twoUsers();
      const token = await tokenFor(alice);
      for (const body of [{}, { currency: "EUR" }, { balance: { amountMinor: 1, currency: "USD" } }]) {
        const response = await raw(app, "PATCH", `/accounts/${aliceAccount}`, { token, idempotencyKey: "update-key-0001", body });
        expect(response.status).toBe(400);
        expect(response.body.error?.code).toBe("validation_failed");
      }
      expect(await getAccountRow(aliceAccount)).toMatchObject({ currency: "USD", balance: 100_000 });
    });

    it("archives and restores", async () => {
      const { asAlice, aliceAccount } = await twoUsers();
      expect((await asAlice.accounts.archive({ id: aliceAccount })).account.archived).toBe(true);
      expect((await asAlice.accounts.list()).items).toEqual([]);
      expect((await asAlice.accounts.get({ id: aliceAccount })).account.archived).toBe(true);
      expect((await asAlice.accounts.restore({ id: aliceAccount })).account.archived).not.toBe(true);
      expect((await asAlice.accounts.list()).items.map((a) => a.id)).toEqual([aliceAccount]);
    });

    it("deletes an unused account, and refuses one in use with conflict", async () => {
      const { asAlice, alice, aliceAccount } = await twoUsers();
      const spare = await seedAccount(alice, { name: "Spare" });
      expect(await asAlice.accounts.delete({ id: spare })).toEqual({ id: spare });
      await expectApiError(asAlice.accounts.get({ id: spare }), "not_found", 404);

      await asAlice.accounts.adjust({ id: aliceAccount, amount: { amountMinor: 1, currency: "USD" } });
      const inUse = await expectApiError(asAlice.accounts.delete({ id: aliceAccount }), "conflict", 409);
      expect(inUse.message).toMatch(/archive it instead/i);

      const goalAccount = await seedAccount(alice, { name: "Goal" });
      await testDb().insert(savingsGoals).values({ userId: alice, name: "g", targetAmount: 1, isVirtual: false, linkedAccountId: goalAccount });
      await expectApiError(asAlice.accounts.delete({ id: goalAccount }), "conflict", 409);
      expect(await getAccountRow(aliceAccount)).toBeDefined();
    });
  });

  it("isolates users: B can't read or change A's account", async () => {
    const { asBob, aliceAccount } = await twoUsers();
    await expectApiError(asBob.accounts.get({ id: aliceAccount }), "not_found", 404);
    await expectApiError(asBob.accounts.adjust({ id: aliceAccount, amount: { amountMinor: 1, currency: "USD" } }), "not_found", 404);
    await expectApiError(asBob.accounts.update({ id: aliceAccount, name: "Hacked" }), "not_found", 404);
    await expectApiError(asBob.accounts.archive({ id: aliceAccount }), "not_found", 404);
    await expectApiError(asBob.accounts.restore({ id: aliceAccount }), "not_found", 404);
    await expectApiError(asBob.accounts.delete({ id: aliceAccount }), "not_found", 404);
    expect((await asBob.accounts.list({ includeArchived: true })).items.map((a) => a.id)).not.toContain(aliceAccount);
    expect(await getAccountRow(aliceAccount)).toMatchObject({ name: "Checking", balance: 100_000, archived: false });
    expect(await transactionRows()).toEqual([]);
  });
});
