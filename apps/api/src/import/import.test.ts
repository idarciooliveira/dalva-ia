/** The Convex import, on a synthetic export: rules, write, verification, and sign-in as an imported user. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { testApp, TEST_PUBLIC_URL } from "../../test/app";
import { asExport, convexFixture, HASHES, writeExportDir, writeExportZip, zip } from "../../test/convex-fixture";
import { testDatabaseUrl, testDb } from "../../test/db";
import {
  accounts,
  authAccounts,
  categories,
  channelIdentities,
  debtPayments,
  debts,
  goalContributions,
  savingsGoals,
  subcategories,
  transactions,
  userProfiles,
  users,
} from "../db/schema";
import { readConvexExport, readZip } from "./convex-export";
import { importId } from "./ids";
import { isCalendarDate, planImport, type Issue, type IssueCode } from "./plan";
import { describeError, formatSummary, importSucceeded, runImport } from "./run";
import { ImportRefusedError, writeImport } from "./write";

type Fixture = ReturnType<typeof convexFixture>;

const id = (table: string, fixture: Fixture, convexId: string) => {
  const doc = fixture[table]!.find((d) => d._id === convexId)!;
  return importId(table, convexId, doc._creationTime as number);
};

const issues = (list: Issue[], code: IssueCode) => list.filter((issue) => issue.code === code);
const codes = (list: Issue[]) => [...new Set(list.map((issue) => issue.code))].sort();

/** The fixture with `edit` applied to a copy. */
function variant(edit: (fixture: Fixture) => void): Fixture {
  const fixture = convexFixture();
  edit(fixture);
  return fixture;
}

/** The fixture's lone outgoing leg is accepted unless a test says otherwise. */
const plan = (source: ReturnType<typeof asExport>, options: Parameters<typeof planImport>[1] = {}) =>
  planImport(source, { acceptLoneLegs: true, ...options });

const find = (fixture: Fixture, table: string, convexId: string) => fixture[table]!.find((d) => d._id === convexId)!;

async function importFixture(fixture: Fixture = convexFixture(), options: { dryRun?: boolean; dropInvalid?: boolean; acceptLoneLegs?: boolean } = {}) {
  const source = await writeExportDir(fixture);
  return await runImport({
    source,
    db: testDb(),
    dryRun: options.dryRun ?? false,
    dropInvalid: options.dropInvalid,
    acceptLoneLegs: options.acceptLoneLegs ?? true,
  });
}

/** Every imported row, ordered, for comparing two runs. */
async function snapshot() {
  const db = testDb();
  return {
    users: await db.select().from(users).orderBy(asc(users.id)),
    authAccounts: await db.select().from(authAccounts).orderBy(asc(authAccounts.id)),
    userProfiles: await db.select().from(userProfiles).orderBy(asc(userProfiles.id)),
    accounts: await db.select().from(accounts).orderBy(asc(accounts.id)),
    categories: await db.select().from(categories).orderBy(asc(categories.id)),
    subcategories: await db.select().from(subcategories).orderBy(asc(subcategories.id)),
    transactions: await db.select().from(transactions).orderBy(asc(transactions.id)),
    savingsGoals: await db.select().from(savingsGoals).orderBy(asc(savingsGoals.id)),
    goalContributions: await db.select().from(goalContributions).orderBy(asc(goalContributions.id)),
    debts: await db.select().from(debts).orderBy(asc(debts.id)),
    debtPayments: await db.select().from(debtPayments).orderBy(asc(debtPayments.id)),
    channelIdentities: await db.select().from(channelIdentities).orderBy(asc(channelIdentities.id)),
  };
}

describe("reading an export", () => {
  it("reads the zip and the unzipped directory the same way", async () => {
    const fixture = convexFixture();
    const fromZip = await readConvexExport(await writeExportZip(fixture));
    const fromDir = await readConvexExport(await writeExportDir(fixture));
    expect(fromZip).toEqual(fromDir);
    expect(fromDir.get("transactions")).toEqual(fixture.transactions);
    // `_tables` and other non-table files are not tables.
    expect(fromDir.has("_tables")).toBe(false);
  });

  it("reads streamed zips: data descriptors and zip64 records, with saturated classic fields", async () => {
    const files: [string, Buffer][] = [
      ["users/", Buffer.alloc(0)],
      ["users/documents.jsonl", Buffer.from('{"_id":"u","_creationTime":1}\n')],
      ["_storage/blob.bin", Buffer.from("not a table")],
    ];
    for (const options of [{ dataDescriptor: true }, { zip64: true }, { dataDescriptor: true, zip64: true }]) {
      expect([...readZip(zip(files, options)).keys()]).toEqual(["users/documents.jsonl", "_storage/blob.bin"]);
      expect([...readZip(zip(files, options), (name) => name.endsWith(".jsonl")).keys()]).toEqual(["users/documents.jsonl"]);
    }
  });

  it("refuses a corrupt zip and something that is not an export", async () => {
    const name = "users/documents.jsonl";
    const good = zip([[name, Buffer.from('{"_id":"u","_creationTime":1}\n'.repeat(3))]]);
    expect([...readZip(good).keys()]).toEqual([name]);
    // Flip a byte of the compressed data.
    const corrupt = Buffer.from(good);
    corrupt[30 + name.length + 3] = corrupt[30 + name.length + 3]! ^ 0xff;
    expect(() => readZip(corrupt)).toThrow(/corrupt|invalid|incorrect/i);
    expect(() => readZip(Buffer.from("not a zip"))).toThrow(/not a zip/);
    const empty = await writeExportDir({});
    await expect(readConvexExport(empty)).rejects.toThrow(/no <table>\/documents.jsonl/);
  });
});

describe("plan", () => {
  it("passes the fixture with warnings only, and maps every migrated table", () => {
    const { report, rows } = plan(asExport(convexFixture()));
    expect(report.errors).toEqual([]);
    expect(report.planned).toEqual({
      users: 3,
      authAccounts: 2,
      userProfiles: 2,
      accounts: 3,
      categories: 3,
      subcategories: 2,
      transactions: 10,
      savingsGoals: 2,
      goalContributions: 2,
      debts: 1,
      debtPayments: 1,
      channelIdentities: 3,
    });
    expect(report.notMigrated).toEqual({
      authSessions: 3,
      authRefreshTokens: 1,
      apiIdempotencyKeys: 1,
      channelLinkCodes: 0,
      agentSessions: 1,
      agentMessages: 1,
    });
    expect(rows.users.map((user) => user.email).sort()).toEqual(["ana@example.com", "bob@example.com", "carl@example.com"]);
  });

  it("builds UUIDv7 ids from _creationTime, the same on every run", () => {
    const fixture = convexFixture();
    const first = plan(asExport(fixture));
    const second = plan(asExport(convexFixture()));
    expect(second.rows).toEqual(first.rows);
    const account = first.rows.accounts[0]!;
    expect(account.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(account.id.replace(/-/g, "").slice(0, 12), 16)).toBe(Math.floor(find(fixture, "accounts", "a_checking")._creationTime as number));
    expect(account.createdAt).toEqual(new Date(Math.floor(find(fixture, "accounts", "a_checking")._creationTime as number)));
    // Distinct per table and document.
    expect(importId("accounts", "x", 1)).not.toBe(importId("categories", "x", 1));
    expect(importId("accounts", "x", 1)).not.toBe(importId("accounts", "y", 1));
  });

  it("merges users whose emails differ only by case into the one that signed in last", () => {
    const fixture = convexFixture();
    const { report, rows } = plan(asExport(fixture));
    const ana2 = id("users", fixture, "u_ana2");
    expect(issues(report.warnings, "email_case_merge")).toEqual([{ code: "email_case_merge", table: "users", id: "u_ana2", detail: "merged u_ana" }]);
    expect(rows.users.find((user) => user.email === "ana@example.com")).toMatchObject({ id: ana2, name: "Ana Two", emailVerified: true });
    // The survivor's password, profile and chat link; every finance row of both.
    expect(rows.authAccounts.find((row) => row.userId === ana2)).toMatchObject({ password: HASHES.umlaut.hash, providerId: "credential", accountId: ana2 });
    expect(rows.userProfiles.filter((row) => row.userId === ana2)).toEqual([expect.objectContaining({ baseCurrency: "EUR" })]);
    expect(issues(report.warnings, "duplicate_profile_dropped")).toEqual([expect.objectContaining({ id: "p_ana", detail: "kept p_ana2" })]);
    expect(rows.accounts.filter((row) => row.userId === ana2).map((row) => row.name).sort()).toEqual(["Checking", "Savings"]);
    const links = rows.channelIdentities.filter((row) => row.userId === ana2);
    expect(links.filter((row) => row.unlinkedAt === null).map((row) => row.externalUserId)).toEqual(["222"]);
    expect(issues(report.warnings, "identity_unlinked").map((issue) => issue.id)).toEqual(["ci_ana"]);
  });

  it("keeps the merged user that has a password, even if another signed in later", () => {
    const fixture = variant((f) => {
      f.authAccounts = f.authAccounts!.filter((account) => account._id !== "aa_ana2");
    });
    const { report, rows } = plan(asExport(fixture));
    const ana = id("users", fixture, "u_ana");
    expect(issues(report.warnings, "email_case_merge")).toEqual([expect.objectContaining({ id: "u_ana", detail: "merged u_ana2" })]);
    // Name and profile from the survivor; its own password.
    expect(rows.users.find((user) => user.email === "ana@example.com")).toMatchObject({ id: ana, name: "Ana" });
    expect(rows.authAccounts.find((row) => row.userId === ana)).toMatchObject({ password: HASHES.staple.hash });
    expect(rows.userProfiles.filter((row) => row.userId === ana)).toEqual([expect.objectContaining({ baseCurrency: "USD" })]);
    expect(issues(report.warnings, "user_without_password").map((issue) => issue.id)).toEqual(["u_carl"]);
  });

  it("supplies users.name from the user, else the profile, else the email", () => {
    const fixture = variant((f) => {
      f.userProfiles = f.userProfiles!.filter((p) => p._id !== "p_bob");
    });
    const names = (f: Fixture) => Object.fromEntries(plan(asExport(f)).rows.users.map((user) => [user.email, user.name]));
    expect(names(convexFixture())).toMatchObject({ "bob@example.com": "Bob Profile", "carl@example.com": "Carl" });
    expect(names(fixture)).toMatchObject({ "bob@example.com": "bob" });
  });

  it("imports a user without a password account, without a credential", () => {
    const { report, rows } = plan(asExport(convexFixture()));
    expect(issues(report.warnings, "user_without_password").map((issue) => issue.id)).toEqual(["u_carl"]);
    expect(issues(report.warnings, "ignored_auth_account").map((issue) => issue.id)).toEqual(["aa_bob_gh"]);
    expect(rows.authAccounts).toHaveLength(2);
  });

  it("nulls dangling and cross-user references on nullable columns", () => {
    const fixture = convexFixture();
    const { report, rows } = plan(asExport(fixture));
    const tx = (convexId: string) => rows.transactions.find((row) => row.id === id("transactions", fixture, convexId))!;
    expect(tx("t_orphan")).toMatchObject({ accountId: null, categoryId: null });
    expect(tx("t_cross")).toMatchObject({ accountId: null, categoryId: null });
    expect(tx("t_food")).toMatchObject({ accountId: id("accounts", fixture, "a_checking"), subcategoryId: id("subcategories", fixture, "sc_groceries") });
    expect(rows.debts[0]).toMatchObject({ linkedAccountId: null });
    expect(rows.goalContributions.find((row) => row.id === id("goalContributions", fixture, "gc_2"))).toMatchObject({ transactionId: null });
    const ref = (issue: Issue) => `${issue.table}.${issue.field} ${issue.id}`;
    expect(issues(report.warnings, "nulled_cross_user_ref").map(ref).sort()).toEqual([
      "debts.linkedAccountId d_card",
      "transactions.accountId t_cross",
      "transactions.categoryId t_cross",
    ]);
    expect(issues(report.warnings, "nulled_dangling_ref").map(ref).sort()).toEqual([
      "goalContributions.transactionId gc_2",
      "transactions.accountId t_orphan",
      "transactions.categoryId t_orphan",
      "transactions.destinationAccountId t_lone_out",
      "transactions.linkedTransactionId t_lone_in",
      "transactions.linkedTransactionId t_lone_out",
    ]);
  });

  it("skips rows whose owner doesn't exist", () => {
    const { report } = plan(asExport(convexFixture()));
    expect(issues(report.warnings, "orphan_owner").map((issue) => `${issue.table} ${issue.id}`)).toEqual(["accounts a_ghost", "transactions t_ghost"]);
  });

  it("fails on a lone outgoing leg whose destination was deleted too, unless accepted", () => {
    const strict = planImport(asExport(convexFixture()));
    expect(strict.report.errors).toEqual([{ code: "lone_outgoing_leg_without_destination", table: "transactions", id: "t_lone_out" }]);
    expect(formatSummary({ mode: "dry-run", committed: false, plan: strict.report, verification: null })).toMatch(/--accept-lone-legs/);
  });

  it("flags lone transfer legs, and the accepted outgoing one whose destination was deleted too", () => {
    const fixture = convexFixture();
    const { report, rows } = plan(asExport(fixture));
    expect(issues(report.warnings, "accepted_lone_outgoing_leg").map((issue) => issue.id)).toEqual(["t_lone_out"]);
    expect(issues(report.warnings, "lone_transfer_leg").map((issue) => issue.id)).toEqual(["t_lone_in"]);
    const loneOut = rows.transactions.find((row) => row.id === id("transactions", fixture, "t_lone_out"))!;
    // Legacy rows keep their account; the group id that is not a UUID gets a stable one.
    expect(loneOut).toMatchObject({ accountId: id("accounts", fixture, "a_checking"), destinationAccountId: null, linkedTransactionId: null });
    expect(loneOut.transferGroupId).toMatch(/^[0-9a-f-]{36}$/);
    expect(issues(report.warnings, "transfer_group_id_rewritten").map((issue) => issue.id)).toEqual(["t_lone_out"]);
    expect(rows.transactions.find((row) => row.id === id("transactions", fixture, "t_out"))!.transferGroupId).toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  });

  it("fails on cross-user or dangling NOT NULL references, unless told to drop them", () => {
    const fixture = variant((f) => {
      find(f, "subcategories", "sc_groceries").categoryId = "c_bob";
      find(f, "goalContributions", "gc_1").goalId = "g_virtual";
      find(f, "debtPayments", "dp_1").debtId = "d_deleted";
    });
    const strict = plan(asExport(fixture));
    expect(strict.report.errors.map((issue) => `${issue.code} ${issue.table}.${issue.field} ${issue.id}`)).toEqual([
      "cross_user_required_ref subcategories.categoryId sc_groceries",
      "cross_user_required_ref goalContributions.goalId gc_1",
      "dangling_required_ref debtPayments.debtId dp_1",
    ]);

    const lenient = plan(asExport(fixture), { dropInvalid: true });
    expect(lenient.report.errors).toEqual([]);
    expect(codes(lenient.report.warnings)).toEqual(expect.arrayContaining(["dropped_cross_user_required_ref", "dropped_dangling_required_ref"]));
    expect(lenient.report.planned).toMatchObject({ subcategories: 1, goalContributions: 1, debtPayments: 0 });
    // A transaction on the dropped subcategory loses it like any dangling reference.
    expect(lenient.rows.transactions.find((row) => row.id === id("transactions", fixture, "t_food"))).toMatchObject({ subcategoryId: null });
  });

  it("fails on amounts that are not integers", () => {
    const fixture = variant((f) => {
      find(f, "accounts", "a_checking").balance = 100.5;
      find(f, "transactions", "t_food").amount = "1250";
      find(f, "debts", "d_card").minimumPayment = 2 ** 60;
      find(f, "debtPayments", "dp_1").interestAmount = null;
      find(f, "savingsGoals", "g_trip").targetAmount = { $float: "NaN" };
    });
    const { report } = plan(asExport(fixture));
    expect(report.errors.map((issue) => `${issue.code} ${issue.id}.${issue.field}`)).toEqual([
      "invalid_amount a_checking.balance",
      "invalid_amount t_food.amount",
      "invalid_amount g_trip.targetAmount",
      "invalid_amount d_card.minimumPayment",
      "invalid_amount dp_1.interestAmount",
    ]);
  });

  it("fails on dates that are not real days", () => {
    expect(["2026-02-28", "2024-02-29", "0001-01-01", "9999-12-31"].every(isCalendarDate)).toBe(true);
    expect(["2026-02-29", "2026-04-31", "2026-13-01", "0000-01-01", "2026-1-01", "2026-01-01T00:00:00Z", ""].some(isCalendarDate)).toBe(false);
    const fixture = variant((f) => {
      find(f, "transactions", "t_food").date = "2026-02-30";
      find(f, "savingsGoals", "g_trip").targetDate = "2026-06-31";
      find(f, "debts", "d_card").createdAt = "yesterday";
    });
    expect(plan(asExport(fixture)).report.errors.map((issue) => `${issue.code} ${issue.id}.${issue.field}`)).toEqual([
      "invalid_date t_food.date",
      "invalid_date g_trip.targetDate",
      "invalid_date d_card.createdAt",
    ]);
  });

  it("fails on password hashes not in the Lucia format, missing emails, bad values and repeated ids", () => {
    const fixture = variant((f) => {
      find(f, "authAccounts", "aa_bob").secret = HASHES.staple.hash.toUpperCase();
      delete find(f, "users", "u_carl").email;
      // Owns a row: can't be skipped.
      f.categories!.push({ _id: "c_carl", _creationTime: 1_767_225_700_000, userId: "u_carl", name: "Misc", type: "expense", isDefault: false });
      find(f, "accounts", "a_savings").type = "crypto";
      find(f, "categories", "c_food").name = "Fo\u0000od";
      find(f, "channelIdentities", "ci_ana").scopes = ["finance:admin"];
      f.debts!.push({ ...find(f, "debts", "d_card") });
      f.categories!.push({ name: "no id" });
    });
    const { report } = plan(asExport(fixture));
    expect(report.errors.map((issue) => `${issue.code} ${issue.table} ${issue.id ?? "-"}.${issue.field ?? "-"}`).sort()).toEqual([
      "duplicate_id debts d_card.-",
      "invalid_document categories -.-",
      "invalid_password_hash authAccounts aa_bob.secret",
      "invalid_value accounts a_savings.type",
      "invalid_value categories c_food.name",
      "invalid_value channelIdentities ci_ana.scopes",
      "missing_email users u_carl.-",
    ]);
  });

  it("keeps the newest of a user's password accounts", () => {
    const fixture = variant((f) => {
      f.authAccounts!.push({ ...find(f, "authAccounts", "aa_bob"), _id: "aa_bob_new", _creationTime: 1_767_300_000_000, secret: HASHES.umlaut.hash });
    });
    const { report, rows } = plan(asExport(fixture));
    expect(issues(report.warnings, "extra_password_account")).toEqual([expect.objectContaining({ id: "aa_bob", detail: "kept aa_bob_new" })]);
    expect(rows.authAccounts.find((row) => row.userId === id("users", fixture, "u_bob"))).toMatchObject({ password: HASHES.umlaut.hash });
  });

  it("fails on sort orders that are not 32-bit integers", () => {
    const fixture = variant((f) => {
      find(f, "categories", "c_food").sortOrder = 1.5;
      find(f, "subcategories", "sc_groceries").sortOrder = 2 ** 31;
    });
    expect(plan(asExport(fixture)).report.errors.map((issue) => `${issue.code} ${issue.id}.${issue.field}`)).toEqual([
      "invalid_value c_food.sortOrder",
      "invalid_value sc_groceries.sortOrder",
    ]);
  });

  it("fails on tables it doesn't know", () => {
    const { report } = plan(asExport({ ...convexFixture(), legacyNotes: [{ _id: "n", _creationTime: 1 }] }));
    expect(report.errors).toEqual([
      { code: "unknown_table", table: "legacyNotes", detail: "1 documents; map the table in the import or drop it in Convex" },
    ]);
  });

  it("skips a user without an email that owns nothing, and ignores malformed sessions", () => {
    const fixture = variant((f) => {
      f.users!.push({ _id: "u_abandoned", _creationTime: 1_767_225_600_000 });
      f.authSessions!.push({ userId: "u_abandoned" }, null as never);
    });
    const { report } = plan(asExport(fixture));
    expect(report.errors).toEqual([]);
    expect(issues(report.warnings, "skipped_user_without_email").map((issue) => issue.id)).toEqual(["u_abandoned"]);
  });

  it("keeps the profile that completed onboarding when merging", () => {
    const fixture = variant((f) => {
      find(f, "userProfiles", "p_ana2").onboardingCompleted = false;
    });
    const { report, rows } = plan(asExport(fixture));
    const ana2 = id("users", fixture, "u_ana2");
    expect(rows.userProfiles.filter((row) => row.userId === ana2)).toEqual([expect.objectContaining({ baseCurrency: "USD", onboardingCompleted: true })]);
    expect(issues(report.warnings, "duplicate_profile_dropped")).toEqual([expect.objectContaining({ id: "p_ana2", detail: "kept p_ana" })]);
  });
});

describe("write", () => {
  it("imports into an empty database, verifies it and commits", async () => {
    const fixture = convexFixture();
    const report = await importFixture(fixture);
    expect(report.committed).toBe(true);
    expect(importSucceeded(report)).toBe(true);
    const verification = report.verification!;
    expect(verification.failures).toEqual([]);
    for (const counts of Object.values(verification.rowCounts)) expect(counts.written).toBe(counts.planned);
    expect(verification.rowCounts.transactions).toEqual({ planned: 10, written: 10 });

    // Opening balances (never a transaction in Convex) are reported, not fixed. Checking: +50000 -1250 -300 -2000
    // +150, and the lone outgoing leg now reads as incoming (+900 instead of -900); Bob's -400 left with its account.
    expect(verification.balances.mismatches).toHaveLength(2);
    expect(verification.balances.mismatches).toEqual(
      expect.arrayContaining([
        { account: "a_checking", stored: 100_000, fromTransactions: 47_500 },
        { account: "a_bob", stored: 5_000, fromTransactions: -1_000 },
      ]),
    );
    expect(verification.balances.changedByImport).toEqual([{ account: "a_checking", convex: 45_300, imported: 47_500 }]);
    expect(verification.references).toEqual({
      transactionsWithoutAccount: 2,
      loneTransferLegs: 2,
      loneLegsWithoutDestination: 2,
      debtPaymentsWithoutAccount: 0,
      debtPaymentsWithoutSourceTransaction: 0,
      goalContributionsWithoutTransaction: 1,
    });
    expect(verification.passwords).toEqual({ fixtureVerified: true, sampled: 2, sampleOk: 2 });

    // Balances and amounts as stored in Convex.
    const [checking] = await testDb().select().from(accounts).where(eq(accounts.id, id("accounts", fixture, "a_checking")));
    expect(checking).toMatchObject({ balance: 100_000, archived: false, currency: "USD" });
    const [goal] = await testDb().select().from(savingsGoals).where(eq(savingsGoals.id, id("savingsGoals", fixture, "g_trip")));
    expect(goal).toMatchObject({ createdOn: "2026-01-02", targetDate: "2026-12-31", currentAmount: 2_000 });
    const [identity] = await testDb().select().from(channelIdentities).where(eq(channelIdentities.id, id("channelIdentities", fixture, "ci_ana2")));
    expect(identity).toMatchObject({ externalUserId: "222", scopes: ["finance:read"], unlinkedAt: null });
    // Postgres reads the id's timestamp as the Convex creation time.
    const [row] = await testDb().execute<{ ts: string }>(
      sql`select (extract(epoch from uuid_extract_timestamp(${id("accounts", fixture, "a_checking")}::uuid)) * 1000)::bigint::text as ts`,
    );
    expect(Number(row!.ts)).toBe(Math.floor(find(fixture, "accounts", "a_checking")._creationTime as number));
    expect(formatSummary(report)).toMatch(/committed/);
  });

  it("checks balances of a transfer whose destination account was deleted, with both legs left", async () => {
    const fixture = variant((f) => {
      f.accounts = f.accounts!.filter((account) => account._id !== "a_savings");
      f.savingsGoals = f.savingsGoals!.filter((goal) => goal._id !== "g_trip");
      f.goalContributions = [];
    });
    const report = await importFixture(fixture);
    expect(report.committed).toBe(true);
    // The outgoing leg lost its destination, the incoming leg its account: still read as outgoing (-2000).
    const [outgoing] = await testDb().select().from(transactions).where(eq(transactions.id, id("transactions", fixture, "t_out")));
    expect(outgoing).toMatchObject({ destinationAccountId: null, linkedTransactionId: id("transactions", fixture, "t_in") });
    expect(report.verification!.balances.changedByImport).toEqual([{ account: "a_checking", convex: 45_300, imported: 47_500 }]);
  });

  it("gives the same rows on a re-run into a fresh database", async () => {
    await importFixture();
    const first = await snapshot();
    await testDb().execute(sql.raw(`truncate ${["users", "auth_accounts", "user_profiles", "accounts", "categories", "subcategories", "transactions", "savings_goals", "goal_contributions", "debts", "debt_payments", "channel_identities"].join(", ")} cascade`));
    await importFixture();
    expect(await snapshot()).toEqual(first);
  });

  it("refuses a database that is not empty, and writes nothing", async () => {
    await testDb().insert(users).values({ name: "Existing", email: "existing@example.com" });
    await expect(importFixture()).rejects.toThrow(ImportRefusedError);
    await expect(importFixture()).rejects.toThrow(/not empty \(users\)/);
    expect(await testDb().select().from(users)).toHaveLength(1);
    expect(await testDb().select().from(accounts)).toHaveLength(0);
  });

  it("refuses a re-run into the database it already filled", async () => {
    await importFixture();
    await expect(importFixture()).rejects.toThrow(/not empty/);
  });

  it("refuses a database that is not fully migrated", async () => {
    const [last] = await testDb().execute<{ id: number; hash: string; created_at: string }>(
      sql`select id, hash, created_at::text from drizzle.__drizzle_migrations order by created_at desc limit 1`,
    );
    await testDb().execute(sql`delete from drizzle.__drizzle_migrations where id = ${last!.id}`);
    try {
      await expect(importFixture()).rejects.toThrow(/not at the current migration/);
    } finally {
      await testDb().execute(sql`insert into drizzle.__drizzle_migrations (id, hash, created_at) values (${last!.id}, ${last!.hash}, ${last!.created_at}::bigint)`);
    }
  });

  it("writes nothing when the plan has errors", async () => {
    const fixture = variant((f) => {
      find(f, "transactions", "t_food").amount = 1.5;
    });
    const report = await importFixture(fixture);
    expect(report).toMatchObject({ committed: false, verification: null });
    expect(importSucceeded(report)).toBe(false);
    expect(formatSummary(report)).toMatch(/error invalid_amount transactions t_food\.amount/);
    expect(await testDb().select().from(users)).toHaveLength(0);
  });

  it("imports with --drop-invalid what a strict run refuses", async () => {
    const fixture = variant((f) => {
      find(f, "debtPayments", "dp_1").debtId = "d_deleted";
    });
    expect(importSucceeded(await importFixture(fixture))).toBe(false);
    const report = await importFixture(fixture, { dropInvalid: true });
    expect(report.committed).toBe(true);
    expect(await testDb().select().from(debtPayments)).toHaveLength(0);
    expect(report.verification!.references.debtPaymentsWithoutAccount).toBe(0);
  });

  it("dry run: writes, verifies and rolls back", async () => {
    const report = await importFixture(convexFixture(), { dryRun: true });
    expect(report).toMatchObject({ mode: "dry-run", committed: false });
    expect(report.verification).toMatchObject({ ok: true, rowCounts: { users: { planned: 3, written: 3 } } });
    expect(await testDb().select().from(users)).toHaveLength(0);
    // Without a database: only the export is checked.
    const offline = await runImport({ source: await writeExportDir(convexFixture()), dryRun: true, acceptLoneLegs: true });
    expect(offline).toMatchObject({ committed: false, verification: null });
    expect(importSucceeded(offline)).toBe(true);
  });

  it("refuses to write a plan with errors", async () => {
    const invalid = plan(asExport(variant((f) => void (find(f, "accounts", "a_bob").balance = 0.1))));
    await expect(writeImport(testDb(), invalid, { dryRun: true })).rejects.toThrow(/plan has errors/);
  });
});

describe("errors", () => {
  it("never show a database error's message, only its codes", () => {
    const pg = Object.assign(new Error("insert or update violates foreign key"), {
      name: "PostgresError",
      code: "23503",
      constraint_name: "transactions_account_id_fk",
      table_name: "transactions",
    });
    const wrapped = Object.assign(new Error("Failed query: insert into users ... params: ana@example.com,df9a91:b7b6"), {
      name: "DrizzleQueryError",
      query: "insert into users",
      params: ["ana@example.com"],
      cause: pg,
    });
    expect(describeError(wrapped)).toBe("database error, code 23503, constraint_name transactions_account_id_fk, table_name transactions");
    const dropped = Object.assign(new Error("Failed query: ... params: ana@example.com"), {
      name: "DrizzleQueryError",
      query: "insert into users",
      cause: Object.assign(new Error("write CONNECTION_CLOSED"), { code: "CONNECTION_CLOSED" }),
    });
    expect(describeError(dropped)).toBe("database error, code CONNECTION_CLOSED");
    expect(describeError(new ImportRefusedError("database is not empty (users)"))).toBe("database is not empty (users)");
    expect(describeError(new Error("export.zip: not a zip file"))).toBe("export.zip: not a zip file");
  });
});

describe("imported users", () => {
  it("sign in through the HTTP API with their original password, whatever the email's case", async () => {
    await importFixture();
    const { app } = testApp();
    const signIn = (email: string, password: string) =>
      app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_PUBLIC_URL },
        body: JSON.stringify({ email, password }),
      });

    // The merge survivor's password; the merged duplicate's no longer works.
    const ana = await signIn("ANA@example.com", HASHES.umlaut.password);
    expect(ana.status).toBe(200);
    const cookie = ana.headers.getSetCookie().find((c) => c.startsWith("dalva.session_token="))!.split(";")[0]!;
    const session = await app.request("/api/auth/get-session", { headers: { cookie } });
    expect(((await session.json()) as { user: { email: string } }).user.email).toBe("ana@example.com");
    expect((await signIn("ana@example.com", HASHES.staple.password)).status).toBe(401);

    expect((await signIn("bob@example.com", HASHES.staple.password)).status).toBe(200);
    expect((await signIn("carl@example.com", HASHES.staple.password)).status).toBe(401);
  });
});

describe("CLI", () => {
  const run = promisify(execFile);
  const cli = join(import.meta.dirname, "../../scripts/migrate-from-convex.ts");

  it("dry-runs an export zip against a database and prints the report", async () => {
    const source = await writeExportZip(convexFixture());
    const reportFile = join(source, "..", "report.json");
    const { stderr } = await run("bun", [cli, source, "--dry-run", "--accept-lone-legs", "--report", reportFile], {
      env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    });
    expect(stderr).toMatch(/Convex import \(dry-run\): nothing committed/);
    expect(stderr).toMatch(/Verification: ok/);
    const report = JSON.parse(await readFile(reportFile, "utf8")) as { verification: { ok: boolean } };
    expect(report.verification.ok).toBe(true);
    // No emails or hashes in the report.
    expect(await readFile(reportFile, "utf8")).not.toMatch(/@example\.com|[0-9a-f]{32}:/);
    expect(await testDb().select().from(users)).toHaveLength(0);
  });

  it("exits 1 on errors and 2 on bad usage", async () => {
    const source = await writeExportDir(variant((f) => void (find(f, "accounts", "a_bob").balance = 0.1)));
    await expect(run("bun", [cli, source, "--dry-run"], { env: { ...process.env, DATABASE_URL: "" } })).rejects.toMatchObject({ code: 1 });
    await expect(run("bun", [cli, source], { env: { ...process.env, DATABASE_URL: "" } })).rejects.toMatchObject({ code: 2 });
    await expect(run("bun", [cli], { env: process.env })).rejects.toMatchObject({ code: 2 });
  });
});
