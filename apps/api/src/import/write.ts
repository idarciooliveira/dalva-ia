/**
 * Writes an {@link ImportPlan} into an empty, migrated database in one
 * transaction, then verifies what it wrote before committing. A dry run does
 * the same and rolls back, so it also proves the rows pass every constraint.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { verifyPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { Database } from "../db/client";
import { MIGRATIONS_FOLDER } from "../db/migrate";
import * as schema from "../db/schema";
import type { Tx } from "../db/tx";
import { PASSWORD_HASH, type ImportPlan, type ImportRows, type ImportTable } from "./plan";

/** Insert order: users before the rows that reference them (that key is immediate); the rest is deferred. */
const TABLES: { key: ImportTable; table: PgTable; name: string }[] = [
  { key: "users", table: schema.users, name: "users" },
  { key: "authAccounts", table: schema.authAccounts, name: "auth_accounts" },
  { key: "userProfiles", table: schema.userProfiles, name: "user_profiles" },
  { key: "accounts", table: schema.accounts, name: "accounts" },
  { key: "categories", table: schema.categories, name: "categories" },
  { key: "subcategories", table: schema.subcategories, name: "subcategories" },
  { key: "transactions", table: schema.transactions, name: "transactions" },
  { key: "savingsGoals", table: schema.savingsGoals, name: "savings_goals" },
  { key: "goalContributions", table: schema.goalContributions, name: "goal_contributions" },
  { key: "debts", table: schema.debts, name: "debts" },
  { key: "debtPayments", table: schema.debtPayments, name: "debt_payments" },
  { key: "channelIdentities", table: schema.channelIdentities, name: "channel_identities" },
];

/** Keeps each INSERT well under Postgres's 65535 bind parameters. */
const BATCH = 500;
/** Imported credentials checked through Better Auth's verifier. */
const PASSWORD_SAMPLE = 5;

/**
 * A Lucia `Scrypt` hash (lucia@3.2.2, the hasher of Convex Auth's Password
 * provider) and its password: Better Auth must accept it before any imported
 * hash is trusted to work.
 */
export const LUCIA_FIXTURE = {
  password: "correct horse battery staple",
  hash: "df9a91756533bb2f19ac803ae304b64f:b7b6522700874ff4746820259f3fba7dbeaaf3bdf3e73845989bd824d573ebd7c0b7e7e43b745067a7ff7ea1aa8986288af10871aebf881115281e4dd5de3c1b",
};

/** The database is not one the import may write to. Nothing was written. */
export class ImportRefusedError extends Error {
  override name = "ImportRefusedError";
}

export interface BalanceMismatch {
  /** Convex account id. */
  account: string;
  stored: number;
  fromTransactions: number;
}

export interface Verification {
  ok: boolean;
  /** Hard failures; the write was rolled back. */
  failures: string[];
  rowCounts: Record<ImportTable, { planned: number; written: number }>;
  balances: {
    accounts: number;
    /**
     * Stored balance ≠ sum of the account's transactions. Expected for an
     * opening balance (Convex never recorded one as a transaction); reported,
     * never fixed.
     */
    mismatches: BalanceMismatch[];
    /**
     * Accounts whose transactions add up differently after the import than in
     * Convex: a transaction lost its account or a transfer leg its direction.
     */
    changedByImport: { account: string; convex: number; imported: number }[];
  };
  references: {
    transactionsWithoutAccount: number;
    loneTransferLegs: number;
    /** Lone legs with neither destination nor account, read as incoming. */
    loneLegsWithoutDestination: number;
    debtPaymentsWithoutAccount: number;
    debtPaymentsWithoutSourceTransaction: number;
    goalContributionsWithoutTransaction: number;
  };
  passwords: { fixtureVerified: boolean; sampled: number; sampleOk: number };
}

/**
 * The failure came after the commit was sent: Postgres may have committed.
 * Inspect the target before retrying (a retry refuses a non-empty database).
 */
export class CommitUnknownError extends Error {
  override name = "CommitUnknownError";
  constructor(override readonly cause: unknown) {
    super("the commit was sent but not confirmed");
  }
}

/** Rolls the transaction back, carrying the result out. */
class Rollback extends Error {
  constructor(readonly verification: Verification) {
    super("rollback");
  }
}

/**
 * Write the plan in one transaction and verify it. Refuses ({@link
 * ImportRefusedError}) a database that is not fully migrated or not empty.
 * Commits only when not a dry run and the verification passed.
 */
export async function writeImport(db: Database, plan: ImportPlan, options: { dryRun: boolean }): Promise<Verification> {
  if (plan.report.errors.length > 0) throw new Error("the plan has errors; nothing to write");
  let commitSent = false;
  try {
    return await db.transaction(
      async (tx) => {
        // Every unqualified name below (inserts, counts, verification) is the public table assertEmpty checked.
        await tx.execute(sql`set local search_path to public`);
        await assertMigrated(tx);
        await assertEmpty(tx);
        for (const { key, table } of TABLES) {
          const rows = plan.rows[key];
          for (let i = 0; i < rows.length; i += BATCH) await tx.insert(table).values(rows.slice(i, i + BATCH) as ImportRows[ImportTable]);
        }
        // Check the deferred keys now, so a bad reference fails here (and in a dry run) rather than at commit.
        await tx.execute(sql`set constraints all immediate`);
        const verification = await verify(tx, plan);
        if (options.dryRun || !verification.ok) throw new Rollback(verification);
        commitSent = true;
        return verification;
      },
      { isolationLevel: "serializable" },
    );
  } catch (error) {
    if (error instanceof Rollback) return error.verification;
    throw commitSent ? new CommitUnknownError(error) : error;
  }
}

async function assertMigrated(tx: Tx) {
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { when: number }[] };
  const expected = journal.entries.map((entry) => String(entry.when));
  const [table] = await tx.execute<{ exists: boolean }>(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`);
  const applied = table?.exists
    ? (await tx.execute<{ when: string }>(sql`select created_at::text as when from drizzle.__drizzle_migrations order by created_at`)).map((row) => row.when)
    : [];
  if (applied.join() !== expected.join()) {
    throw new ImportRefusedError(
      `database is not at the current migration (${applied.length} of ${expected.length} applied): run \`bun run db:migrate\` first`,
    );
  }
}

async function assertEmpty(tx: Tx) {
  const tables = await tx.execute<{ name: string }>(sql`select quote_ident(tablename) as name from pg_tables where schemaname = 'public' order by tablename`);
  const nonEmpty: string[] = [];
  for (const { name } of tables) {
    const [row] = await tx.execute<{ any: boolean }>(sql.raw(`select exists (select 1 from public.${name}) as any`));
    if (row?.any) nonEmpty.push(name);
  }
  if (nonEmpty.length > 0) throw new ImportRefusedError(`database is not empty (${nonEmpty.join(", ")}): import only into a fresh, migrated database`);
}

async function verify(tx: Tx, plan: ImportPlan): Promise<Verification> {
  const failures: string[] = [];

  const rowCounts = {} as Verification["rowCounts"];
  for (const { key, name } of TABLES) {
    const [row] = await tx.execute<{ n: string }>(sql.raw(`select count(*)::text as n from ${name}`));
    const written = Number(row?.n ?? 0);
    rowCounts[key] = { planned: plan.rows[key].length, written };
    if (written !== plan.rows[key].length) failures.push(`${name}: wrote ${written} rows, planned ${plan.rows[key].length}`);
  }

  // Each balance against its transactions, with the legs told apart the way the transfer code does (legsOf).
  const sums = await tx.execute<{ id: string; balance: string; effect: string }>(sql`
    select a.id, a.balance::text as balance, coalesce(sum(
      case
        when t.type = 'expense' then -t.amount
        when t.type = 'transfer' and (
          t.destination_account_id is not null
          or (l.id is not null and l.destination_account_id is null and l.account_id is null)
        ) then -t.amount
        else t.amount
      end), 0)::text as effect
    from accounts a
    left join transactions t on t.account_id = a.id
    left join transactions l on l.id = t.linked_transaction_id
    group by a.id, a.balance
    order by a.id
  `);
  const balances: Verification["balances"] = { accounts: sums.length, mismatches: [], changedByImport: [] };
  for (const row of sums) {
    const expected = plan.balances.get(row.id);
    const stored = Number(row.balance);
    const effect = Number(row.effect);
    if (!expected) {
      failures.push(`account ${row.id} was not planned`);
      continue;
    }
    if (stored !== expected.balance) failures.push(`account ${expected.convexId}: stored balance differs from the export`);
    if (stored !== effect) balances.mismatches.push({ account: expected.convexId, stored, fromTransactions: effect });
    if (effect !== expected.convexEffect) balances.changedByImport.push({ account: expected.convexId, convex: expected.convexEffect, imported: effect });
  }

  const [refs] = await tx.execute<Record<keyof Verification["references"], string>>(sql`
    select
      (select count(*) from transactions where account_id is null)::text as "transactionsWithoutAccount",
      (select count(*) from transactions where type = 'transfer' and linked_transaction_id is null)::text as "loneTransferLegs",
      (select count(*) from transactions where type = 'transfer' and linked_transaction_id is null
        and destination_account_id is null)::text as "loneLegsWithoutDestination",
      (select count(*) from debt_payments where from_account_id is null)::text as "debtPaymentsWithoutAccount",
      (select count(*) from debt_payments where source_transaction_id is null)::text as "debtPaymentsWithoutSourceTransaction",
      (select count(*) from goal_contributions c join savings_goals g on g.id = c.goal_id
        where not g.is_virtual and c.transaction_id is null)::text as "goalContributionsWithoutTransaction"
  `);
  const references = Object.fromEntries(Object.entries(refs ?? {}).map(([key, value]) => [key, Number(value)])) as Verification["references"];

  // Better Auth must verify a Lucia hash, and every sampled imported hash must come back intact and be one its
  // verifier parses (a wrong password is refused, not an exception).
  const fixtureVerified = await verifyPassword({ hash: LUCIA_FIXTURE.hash, password: LUCIA_FIXTURE.password });
  if (!fixtureVerified) failures.push("Better Auth did not verify the Lucia fixture hash");
  const planned = new Map(plan.rows.authAccounts.map((row) => [row.id, row.password]));
  const sample = await tx.execute<{ id: string; password: string | null }>(
    sql`select id, password from auth_accounts order by id limit ${PASSWORD_SAMPLE}`,
  );
  let sampleOk = 0;
  for (const row of sample) {
    const intact = row.password !== null && row.password === planned.get(row.id) && PASSWORD_HASH.test(row.password);
    const refused = intact && !(await verifyPassword({ hash: row.password!, password: randomBytes(18).toString("base64") }).catch(() => true));
    if (refused) sampleOk++;
    else failures.push(`credential ${row.id}: hash altered or not readable by Better Auth`);
  }

  return {
    ok: failures.length === 0,
    failures,
    rowCounts,
    balances,
    references,
    passwords: { fixtureVerified, sampled: sample.length, sampleOk },
  };
}
