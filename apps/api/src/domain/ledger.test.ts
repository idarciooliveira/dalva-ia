import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  balanceOf,
  domainRejection,
  getTransactionRow,
  seedAccount,
  seedContribution,
  seedDebt,
  seedDebtPayment,
  seedTransaction,
  transactionRows,
  twoUsers,
} from "../../test/api";
import { createTestUser } from "../../test/app";
import { testDb } from "../../test/db";
import { debtPayments, transactions } from "../db/schema";
import { readTx, type Tx, withTx } from "../db/tx";
import * as ledger from "./ledger";

const tx = <T>(fn: (tx: Tx) => Promise<T>) => withTx(testDb(), fn);
const read = <T>(fn: (tx: Tx) => Promise<T>) => readTx(testDb(), fn);

const DAY = "2026-03-10";

const post = (userId: string, posting: ledger.Posting) => tx((t) => ledger.post(t, userId, posting));
const expense = (userId: string, accountId: string, amount = 1_000) => post(userId, { type: "expense", amount, accountId, date: DAY });
const transfer = (userId: string, fromAccountId: string, toAccountId: string, amount = 1_000) =>
  post(userId, { type: "transfer", amount, fromAccountId, toAccountId, date: DAY, description: "Move" }) as Promise<ledger.TransferEntry>;

/**
 * The invariant: every account's balance is its opening balance plus the
 * signed effect of the rows posted on it. Holds for rows the ledger wrote
 * (outgoing transfer legs carry `destination_account_id`).
 */
async function expectBalancesMatchRows(opening: Record<string, number>) {
  const rows = await transactionRows();
  for (const [accountId, start] of Object.entries(opening)) {
    const posted = rows
      .filter((r) => r.accountId === accountId)
      .reduce((sum, r) => {
        const debit = r.type === "expense" || (r.type === "transfer" && r.destinationAccountId !== null);
        return sum + (debit ? -r.amount : r.amount);
      }, 0);
    expect(await balanceOf(accountId), accountId).toBe(start + posted);
  }
}

const legsOf = (entry: ledger.Entry) => (entry.kind === "transfer" ? [entry.outgoing, entry.incoming] : [entry.row]);

describe("domain/ledger", () => {
  describe("balance invariant", () => {
    it("post moves the account by the row's signed amount", async () => {
      const alice = await createTestUser();
      const accountId = await seedAccount(alice, { balance: 10_000 });
      const spent = await expense(alice, accountId, 1_500);
      await post(alice, { type: "income", amount: 5_000, accountId, date: DAY, payee: "ACME" });
      await post(alice, { type: "adjustment", amount: -200, accountId, date: DAY });

      expect(spent).toMatchObject({ kind: "single", owner: "manual", row: { type: "expense", amount: 1_500, accountId } });
      expect(spent.id).toBe((spent as ledger.SingleEntry).row.id);
      expect(await balanceOf(accountId)).toBe(10_000 - 1_500 + 5_000 - 200);
      await expectBalancesMatchRows({ [accountId]: 10_000 });
    });

    it("post writes a transfer as two linked legs", async () => {
      const alice = await createTestUser();
      const from = await seedAccount(alice, { balance: 10_000 });
      const to = await seedAccount(alice, { balance: 500 });
      const entry = await transfer(alice, from, to);

      expect(entry).toMatchObject({ kind: "transfer", owner: "transfer", id: entry.outgoing!.id });
      const outgoing = await getTransactionRow(entry.outgoing!.id);
      const incoming = await getTransactionRow(entry.incoming!.id);
      expect(outgoing).toMatchObject({ type: "transfer", amount: 1_000, accountId: from, destinationAccountId: to, linkedTransactionId: incoming!.id });
      expect(incoming).toMatchObject({ type: "transfer", amount: 1_000, accountId: to, destinationAccountId: null, linkedTransactionId: outgoing!.id });
      expect(outgoing!.transferGroupId).toBeTruthy();
      expect(incoming!.transferGroupId).toBe(outgoing!.transferGroupId);
      expect([await balanceOf(from), await balanceOf(to)]).toEqual([9_000, 1_500]);
    });

    it("amend reverses the old effect and applies the new one", async () => {
      const alice = await createTestUser();
      const first = await seedAccount(alice, { balance: 10_000 });
      const second = await seedAccount(alice, { balance: 2_000 });
      const opening = { [first]: 10_000, [second]: 2_000 };
      const entry = await expense(alice, first);

      const moved = await tx(async (t) =>
        ledger.amend(t, alice, await ledger.open(t, alice, entry.id, "manual"), { type: "income", amount: 400, accountId: second, note: "moved" }),
      );
      expect(moved.row).toMatchObject({ type: "income", amount: 400, accountId: second, note: "moved" });
      expect([await balanceOf(first), await balanceOf(second)]).toEqual([10_000, 2_400]);
      await expectBalancesMatchRows(opening);

      // Same account: only the difference lands. `null` clears a nullable field.
      await tx(async (t) => ledger.amend(t, alice, await ledger.open(t, alice, entry.id, "manual"), { type: "adjustment", amount: -50, note: null }));
      expect(await balanceOf(second)).toBe(1_950);
      expect(await getTransactionRow(entry.id)).toMatchObject({ note: null });
      await expectBalancesMatchRows(opening);
    });

    it("amend moves a transfer's legs and only touches the fields given", async () => {
      const alice = await createTestUser();
      const from = await seedAccount(alice, { balance: 10_000 });
      const to = await seedAccount(alice, { balance: 0 });
      const other = await seedAccount(alice, { balance: 0 });
      const opening = { [from]: 10_000, [to]: 0, [other]: 0 };
      const entry = await transfer(alice, from, to);
      await testDb().update(transactions).set({ note: "incoming's own" }).where(eq(transactions.id, entry.incoming!.id));

      // Opened through the incoming leg: the entry is the same.
      const amended = await tx(async (t) =>
        ledger.amend(t, alice, await ledger.open(t, alice, entry.incoming!.id, "transfer"), { amount: 400, toAccountId: other, date: "2026-03-12" }),
      );
      expect(amended.outgoing).toMatchObject({ amount: 400, accountId: from, destinationAccountId: other, date: "2026-03-12", note: null });
      expect(amended.incoming).toMatchObject({ amount: 400, accountId: other, note: "incoming's own", description: "Move" });
      expect([await balanceOf(from), await balanceOf(to), await balanceOf(other)]).toEqual([9_600, 0, 400]);
      await expectBalancesMatchRows(opening);

      // Swapping both ends at once.
      await tx(async (t) => ledger.amend(t, alice, await ledger.open(t, alice, entry.id, "transfer"), { fromAccountId: other, toAccountId: from }));
      expect([await balanceOf(from), await balanceOf(other)]).toEqual([10_400, -400]);
      await expectBalancesMatchRows(opening);
    });

    it("reverse deletes every leg and undoes its effect, from either leg", async () => {
      const alice = await createTestUser();
      const from = await seedAccount(alice, { balance: 10_000 });
      const to = await seedAccount(alice, { balance: 0 });
      for (const pick of ["outgoing", "incoming"] as const) {
        const entry = await transfer(alice, from, to, 700);
        await tx(async (t) => ledger.reverse(t, alice, [await ledger.open(t, alice, entry[pick]!.id, "transfer")]));
      }
      const single = await expense(alice, from, 300);
      await tx(async (t) => ledger.reverse(t, alice, [await ledger.open(t, alice, single.id, "manual")]));
      expect([await balanceOf(from), await balanceOf(to)]).toEqual([10_000, 0]);
      expect(await transactionRows()).toEqual([]);
    });

    it("rejects zero, negative and non-integer amounts (signed only for adjustments), writing nothing", async () => {
      const alice = await createTestUser();
      const accountId = await seedAccount(alice, { balance: 10_000 });
      const other = await seedAccount(alice);
      for (const amount of [0, -100, 10.5, Number.NaN]) {
        expect(await domainRejection(expense(alice, accountId, amount))).toMatchObject({ code: "validation_failed" });
        expect(await domainRejection(transfer(alice, accountId, other, amount))).toMatchObject({ code: "validation_failed" });
      }
      expect(await domainRejection(post(alice, { type: "adjustment", amount: 1.5, accountId, date: DAY }))).toMatchObject({
        message: "Amount must be an integer",
      });
      // The sign rule uses the effective type: a negative adjustment can't just become income.
      const adjustment = await post(alice, { type: "adjustment", amount: -500, accountId, date: DAY });
      expect(
        await domainRejection(tx(async (t) => ledger.amend(t, alice, await ledger.open(t, alice, adjustment.id, "manual"), { type: "income" }))),
      ).toEqual({ code: "validation_failed", message: "Amount must be positive" });
      expect(await balanceOf(accountId)).toBe(9_500);
      expect(await transactionRows()).toHaveLength(1);
    });
  });

  describe("currencies", () => {
    it("refuses a transfer across currencies or onto the same account, on post and amend", async () => {
      const alice = await createTestUser();
      const usd = await seedAccount(alice, { balance: 10_000 });
      const usd2 = await seedAccount(alice);
      const eur = await seedAccount(alice, { currency: "EUR" });
      expect(await domainRejection(transfer(alice, usd, eur))).toEqual({
        code: "validation_failed",
        message: "Cross-currency transfers are not supported (USD -> EUR)",
      });
      expect(await domainRejection(transfer(alice, usd, usd))).toEqual({ code: "validation_failed", message: "Cannot transfer to the same account" });
      expect(await transactionRows()).toEqual([]);

      const entry = await transfer(alice, usd, usd2);
      for (const changes of [{ toAccountId: eur }, { fromAccountId: eur }, { toAccountId: usd }]) {
        expect(
          await domainRejection(tx(async (t) => ledger.amend(t, alice, await ledger.open(t, alice, entry.id, "transfer"), changes))),
        ).toMatchObject({ code: "validation_failed" });
      }
      expect([await balanceOf(usd), await balanceOf(usd2), await balanceOf(eur)]).toEqual([9_000, 1_000, 0]);
    });

    it("reverses legacy legs in different currencies, each on its own account", async () => {
      const alice = await createTestUser();
      const usd = await seedAccount(alice, { balance: 9_000 });
      const eur = await seedAccount(alice, { currency: "EUR", balance: 900 });
      const group = randomUUID();
      const outgoing = await seedTransaction(alice, usd, { type: "transfer", amount: 1_000, destinationAccountId: eur, transferGroupId: group });
      const incoming = await seedTransaction(alice, eur, { type: "transfer", amount: 900, transferGroupId: group, linkedTransactionId: outgoing });
      await testDb().update(transactions).set({ linkedTransactionId: incoming }).where(eq(transactions.id, outgoing));

      const entry = await read((t) => ledger.open(t, alice, incoming, "transfer", "read"));
      expect([entry.outgoing?.id, entry.incoming?.id]).toEqual([outgoing, incoming]);
      await tx(async (t) => ledger.reverse(t, alice, [await ledger.open(t, alice, outgoing, "transfer")]));
      expect([await balanceOf(usd), await balanceOf(eur)]).toEqual([10_000, 0]);
    });

    it("checks the balance range in each account's own currency", async () => {
      const alice = await createTestUser();
      // KWD has 3 decimals: the stored ×100 amount × 10 must stay a safe integer.
      const kwdLimit = Math.floor(Number.MAX_SAFE_INTEGER / 10);
      const kwd = await seedAccount(alice, { currency: "KWD", balance: kwdLimit - 5 });
      const usd = await seedAccount(alice, { balance: kwdLimit - 5 });
      expect(await domainRejection(post(alice, { type: "income", amount: 10, accountId: kwd, date: DAY }))).toEqual({
        code: "validation_failed",
        message: "Balance out of range",
      });
      await post(alice, { type: "income", amount: 10, accountId: usd, date: DAY });
      expect([await balanceOf(kwd), await balanceOf(usd)]).toEqual([kwdLimit - 5, kwdLimit + 5]);
    });
  });

  describe("range overflow", () => {
    it("refuses a balance past the safe integer range on post, amend and reverse, writing nothing", async () => {
      const alice = await createTestUser();
      const top = Number.MAX_SAFE_INTEGER - 10;
      const full = await seedAccount(alice, { balance: top });
      const other = await seedAccount(alice, { balance: 10_000 });
      expect(await domainRejection(post(alice, { type: "income", amount: 100, accountId: full, date: DAY }))).toMatchObject({
        code: "validation_failed",
      });
      expect(await domainRejection(transfer(alice, other, full, 100))).toMatchObject({ code: "validation_failed" });

      const spent = await expense(alice, other, 100);
      expect(
        await domainRejection(tx(async (t) => ledger.amend(t, alice, await ledger.open(t, alice, spent.id, "manual"), { type: "income", accountId: full }))),
      ).toMatchObject({ code: "validation_failed" });

      // Reversing a debit on a full account credits it back past the range.
      await testDb().update(transactions).set({ accountId: full }).where(eq(transactions.id, spent.id));
      expect(
        await domainRejection(tx(async (t) => ledger.reverse(t, alice, [await ledger.open(t, alice, spent.id, "manual")]))),
      ).toMatchObject({ code: "validation_failed", message: "Balance out of range" });

      expect([await balanceOf(full), await balanceOf(other)]).toEqual([top, 9_900]);
      expect(await transactionRows()).toHaveLength(1);
    });
  });

  describe("legacy rows without an account", () => {
    it("amends and reverses a single row without an account, and moves it onto one", async () => {
      const alice = await createTestUser();
      const accountId = await seedAccount(alice, { balance: 10_000 });
      const orphan = await seedTransaction(alice, null, { amount: 700 });
      const kept = await tx(async (t) => ledger.amend(t, alice, await ledger.open(t, alice, orphan, "manual"), { note: "kept" }));
      expect(kept.row).toMatchObject({ accountId: null, note: "kept" });
      await tx(async (t) => ledger.amend(t, alice, await ledger.open(t, alice, orphan, "manual"), { accountId }));
      expect(await balanceOf(accountId)).toBe(9_300);

      const other = await seedTransaction(alice, null, { type: "income", amount: 50 });
      await tx(async (t) => ledger.reverse(t, alice, [await ledger.open(t, alice, other, "manual")]));
      expect(await getTransactionRow(other)).toBeUndefined();
      expect(await balanceOf(accountId)).toBe(9_300);
    });

    it("reverses a transfer whose leg lost its account, moving only the live leg", async () => {
      const alice = await createTestUser();
      const from = await seedAccount(alice, { balance: 10_000 });
      const entry = await transfer(alice, from, await seedAccount(alice));
      await testDb().update(transactions).set({ accountId: null }).where(eq(transactions.id, entry.incoming!.id));

      // Amending needs both accounts.
      expect(
        await domainRejection(tx(async (t) => ledger.amend(t, alice, await ledger.open(t, alice, entry.id, "transfer"), { amount: 10 }))),
      ).toEqual({ code: "not_found", message: "Account not found" });
      await tx(async (t) => ledger.reverse(t, alice, [await ledger.open(t, alice, entry.id, "transfer")]));
      expect(await balanceOf(from)).toBe(10_000);
      expect(await transactionRows()).toEqual([]);
    });

    it("tells the legs apart when the import nulled the destination", async () => {
      const alice = await createTestUser();
      const from = await seedAccount(alice, { balance: 10_000 });
      for (const pick of ["outgoing", "incoming"] as const) {
        const entry = await transfer(alice, from, await seedAccount(alice));
        const legs = { outgoing: entry.outgoing!.id, incoming: entry.incoming!.id };
        // No destination on the outgoing leg, no account on the incoming one; the incoming leg is the older row.
        await testDb().update(transactions).set({ destinationAccountId: null, createdAt: new Date("2026-01-01T00:00:01Z") }).where(eq(transactions.id, legs.outgoing));
        await testDb().update(transactions).set({ accountId: null, createdAt: new Date("2026-01-01T00:00:00Z") }).where(eq(transactions.id, legs.incoming));

        const opened = await read((t) => ledger.open(t, alice, legs[pick], "transfer", "read"));
        expect([opened.outgoing?.id, opened.incoming?.id]).toEqual([legs.outgoing, legs.incoming]);
        await tx(async (t) => ledger.reverse(t, alice, [await ledger.open(t, alice, legs[pick], "transfer")]));
        expect(await balanceOf(from), pick).toBe(10_000);
      }
    });

    it("opens a leg whose pair is gone on its own, and refuses to amend it", async () => {
      const alice = await createTestUser();
      const from = await seedAccount(alice, { balance: 10_000 });
      const to = await seedAccount(alice, { balance: 5_000 });
      const lonelyOutgoing = await seedTransaction(alice, from, { type: "transfer", amount: 300, destinationAccountId: to });
      const lonelyIncoming = await seedTransaction(alice, to, { type: "transfer", amount: 200 });

      const opened = await read((t) => ledger.open(t, alice, lonelyOutgoing, "transfer", "read"));
      expect([opened.outgoing?.id, opened.incoming]).toEqual([lonelyOutgoing, null]);
      expect(
        await domainRejection(tx(async (t) => ledger.amend(t, alice, await ledger.open(t, alice, lonelyIncoming, "transfer"), { note: "x" }))),
      ).toEqual({ code: "not_found", message: "Transfer not found" });

      await tx(async (t) => ledger.reverse(t, alice, [await ledger.open(t, alice, lonelyOutgoing, "transfer")]));
      await tx(async (t) => ledger.reverse(t, alice, [await ledger.open(t, alice, lonelyIncoming, "transfer")]));
      // The outgoing leg had debited `from`, the incoming one had credited `to`.
      expect([await balanceOf(from), await balanceOf(to)]).toEqual([10_300, 4_800]);
    });
  });

  describe("owners", () => {
    async function scene() {
      const alice = await createTestUser();
      const from = await seedAccount(alice, { balance: 10_000 });
      const goalAccount = await seedAccount(alice, { name: "Goal" });
      const loan = await seedAccount(alice, { type: "loan" });
      const debtId = await seedDebt(alice, { linkedAccountId: loan });

      const manual = (await expense(alice, from)).id;
      const plain = await transfer(alice, from, goalAccount);
      const saved = await transfer(alice, from, goalAccount, 500);
      await seedContribution(alice, saved.id, goalAccount);
      const payment = await seedDebtPayment(alice, { debtId, fromAccountId: from, liabilityAccountId: loan });
      // Rows two owners point at: the more specific one wins.
      const paidLeg = await transfer(alice, from, goalAccount, 10);
      const both = (await expense(alice, from, 20)).id;
      await testDb().insert(debtPayments).values([
        { userId: alice, debtId, amount: 10, principalAmount: 10, interestAmount: 0, date: DAY, sourceTransactionId: paidLeg.id },
        { userId: alice, debtId, amount: 20, principalAmount: 20, interestAmount: 0, date: DAY, sourceTransactionId: both },
      ]);
      await seedContribution(alice, both, goalAccount);

      const expected: Record<string, ledger.Owner> = {
        [manual]: "manual",
        [plain.outgoing!.id]: "transfer",
        [plain.incoming!.id]: "transfer",
        [saved.outgoing!.id]: "goal_contribution",
        [saved.incoming!.id]: "goal_contribution",
        [payment.sourceTransactionId]: "debt_payment",
        [payment.liabilityTransactionId!]: "debt_payment",
        [paidLeg.outgoing!.id]: "transfer",
        [paidLeg.incoming!.id]: "transfer",
        [both]: "goal_contribution",
      };
      return { alice, expected };
    }

    it("resolves goal contribution > transfer > debt payment > manual, in batch and per entry", async () => {
      const { alice, expected } = await scene();
      const rows = await transactionRows();
      const owners = await read((t) => ledger.ownersOf(t, alice, rows));
      expect(Object.fromEntries(owners)).toEqual(expected);
      for (const [id, owner] of Object.entries(expected)) {
        expect((await read((t) => ledger.open(t, alice, id, owner))).owner, id).toBe(owner);
      }
    });

    it("refuses to open an entry for anyone but its owner", async () => {
      const { alice, expected } = await scene();
      const rowsBefore = await transactionRows();
      for (const [id, owner] of Object.entries(expected)) {
        for (const as of ["manual", "goal_contribution", "debt_payment"] as const) {
          if (as === owner) continue;
          expect(await domainRejection(read((t) => ledger.open(t, alice, id, as))), `${id} as ${as}`).toEqual({
            code: "conflict",
            message: ledger.MANAGED_MESSAGES[owner],
          });
        }
        // Transfer endpoints address transfer legs only: anything else is not a transfer at all.
        const asTransfer = await domainRejection(read((t) => ledger.open(t, alice, id, "transfer"))).catch(() => null);
        if (owner === "transfer") expect(asTransfer).toBeNull();
        else if (owner === "goal_contribution" && rowsBefore.find((r) => r.id === id)!.type === "transfer") {
          expect(asTransfer, id).toEqual({ code: "conflict", message: ledger.MANAGED_MESSAGES.goal_contribution });
        } else expect(asTransfer, id).toEqual({ code: "not_found", message: "Transfer not found" });
      }
    });

    it("reads a managed transfer without refusing it", async () => {
      const { alice, expected } = await scene();
      const saved = Object.keys(expected).find((id) => expected[id] === "goal_contribution")!;
      expect(await read((t) => ledger.open(t, alice, saved, "transfer", "read"))).toMatchObject({ kind: "transfer", owner: "goal_contribution" });
    });

    it("opens many entries at once, refusing the batch if any is someone else's", async () => {
      const { alice, expected } = await scene();
      const paid = Object.keys(expected).filter((id) => expected[id] === "debt_payment");
      expect((await read((t) => ledger.openAll(t, alice, paid, "debt_payment"))).map((e) => e.id).sort()).toEqual([...paid].sort());
      const manual = Object.keys(expected).find((id) => expected[id] === "manual")!;
      expect(await domainRejection(read((t) => ledger.openAll(t, alice, [...paid, manual], "debt_payment")))).toMatchObject({ code: "conflict" });
    });
  });

  describe("per-user isolation", () => {
    it("never opens, posts on or moves another user's rows and accounts", async () => {
      const { alice, bob, aliceAccount, bobAccount } = await twoUsers();
      const aliceOther = await seedAccount(alice);
      const mine = await expense(alice, aliceAccount);
      const moved = await transfer(alice, aliceAccount, aliceOther);

      for (const as of ["manual", "transfer"] as const) {
        expect(await domainRejection(read((t) => ledger.open(t, bob, mine.id, as)))).toMatchObject({ code: "not_found" });
        expect(await domainRejection(read((t) => ledger.open(t, bob, moved.id, as)))).toMatchObject({ code: "not_found" });
      }
      expect(await domainRejection(read((t) => ledger.openAll(t, bob, [mine.id], "manual")))).toMatchObject({ code: "not_found" });
      expect(await domainRejection(expense(bob, aliceAccount))).toEqual({ code: "not_found", message: "Account not found" });
      for (const [from, to] of [[bobAccount, aliceAccount], [aliceAccount, bobAccount]] as const) {
        expect(await domainRejection(transfer(bob, from, to))).toEqual({ code: "not_found", message: "Account not found" });
      }
      expect(
        await domainRejection(tx(async (t) => ledger.amend(t, alice, await ledger.open(t, alice, mine.id, "manual"), { accountId: bobAccount }))),
      ).toEqual({ code: "not_found", message: "Account not found" });
      expect(
        await domainRejection(tx(async (t) => ledger.amend(t, alice, await ledger.open(t, alice, moved.id, "transfer"), { toAccountId: bobAccount }))),
      ).toEqual({ code: "not_found", message: "Account not found" });

      // Owners only count the caller's goal and debt rows.
      const owners = await read((t) => ledger.ownersOf(t, bob, legsOf(mine).filter((r) => r !== null)));
      expect(owners.get(mine.id)).toBe("manual");
      expect([await balanceOf(aliceAccount), await balanceOf(aliceOther), await balanceOf(bobAccount)]).toEqual([98_000, 1_000, 50_000]);
    });
  });
});
