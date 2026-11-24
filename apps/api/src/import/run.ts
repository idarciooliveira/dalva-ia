import type { Database } from "../db/client";
import { readConvexExport } from "./convex-export";
import { planImport, type IssueCode, type PlanReport } from "./plan";
import { CommitUnknownError, ImportRefusedError, writeImport, type Verification } from "./write";

export interface ImportReport {
  mode: "dry-run" | "import";
  /** True only when a real run committed. */
  committed: boolean;
  plan: PlanReport;
  /** Null when the plan had errors or a dry run had no database. */
  verification: Verification | null;
}

export interface RunImportOptions {
  /** A `npx convex export` zip or the directory it unzips to. */
  source: string;
  /** Required for a real run; optional for a dry run (without it only the export is checked). */
  db?: Database;
  dryRun: boolean;
  dropInvalid?: boolean;
  acceptLoneLegs?: boolean;
}

/**
 * Read, validate and (unless the plan has errors) write the export. A dry run
 * with a database writes and verifies inside a transaction it rolls back.
 * Throws `ImportRefusedError` for a database that is not empty and migrated.
 */
export async function runImport(options: RunImportOptions): Promise<ImportReport> {
  if (!options.dryRun && !options.db) throw new Error("a real run needs a database");
  const plan = planImport(await readConvexExport(options.source), { dropInvalid: options.dropInvalid, acceptLoneLegs: options.acceptLoneLegs });
  const mode = options.dryRun ? "dry-run" : "import";
  if (plan.report.errors.length > 0 || !options.db) return { mode, committed: false, plan: plan.report, verification: null };
  const verification = await writeImport(options.db, plan, { dryRun: options.dryRun });
  return { mode, committed: !options.dryRun && verification.ok, plan: plan.report, verification };
}

/** The run succeeded: no plan errors and, when verified, no failures. */
export function importSucceeded(report: ImportReport): boolean {
  return report.plan.errors.length === 0 && (report.verification?.ok ?? true);
}

/** A short human summary (ids and counts only). The JSON report has every issue. */
export function formatSummary(report: ImportReport): string {
  const lines: string[] = [];
  const { plan, verification } = report;
  lines.push(`Convex import (${report.mode}): ${report.committed ? "committed" : "nothing committed"}`);
  lines.push(`Source documents: ${Object.entries(plan.source).map(([t, n]) => `${t} ${n}`).join(", ") || "none"}`);
  lines.push(`Planned rows: ${Object.entries(plan.planned).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  if (Object.keys(plan.notMigrated).length > 0) {
    lines.push(`Not migrated: ${Object.entries(plan.notMigrated).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  }
  const counts = (Object.entries(plan.counts) as [IssueCode, number][]).map(([code, n]) => `${code} ${n}`);
  lines.push(`Issues: ${counts.join(", ") || "none"}`);
  for (const issue of plan.errors.slice(0, 20)) {
    lines.push(`  error ${issue.code} ${issue.table}${issue.id ? ` ${issue.id}` : ""}${issue.field ? `.${issue.field}` : ""}${issue.detail ? `: ${issue.detail}` : ""}`);
  }
  if (plan.errors.length > 20) lines.push(`  ... ${plan.errors.length - 20} more errors in the JSON report`);
  if (plan.errors.length > 0) lines.push("Fix the errors in Convex (or pass --drop-invalid for the required-reference ones, --accept-lone-legs for the lone outgoing legs) and run again.");
  if (verification) {
    lines.push(`Verification: ${verification.ok ? "ok" : "FAILED"}`);
    for (const failure of verification.failures) lines.push(`  ${failure}`);
    lines.push(
      `  balances: ${verification.balances.accounts} accounts, ${verification.balances.mismatches.length} differ from their transactions (opening balances), ` +
        `${verification.balances.changedByImport.length} changed by the import`,
    );
    lines.push(`  references: ${Object.entries(verification.references).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    lines.push(
      `  passwords: fixture ${verification.passwords.fixtureVerified ? "verified" : "NOT verified"}, sample ${verification.passwords.sampleOk}/${verification.passwords.sampled}`,
    );
  }
  return lines.join("\n");
}

/**
 * A failed run, for the terminal. A database error is never shown by its
 * message: Drizzle's quotes the query and its parameters (emails, password
 * hashes). Only its codes, constraint and table are.
 */
export function describeError(error: unknown): string {
  if (error instanceof ImportRefusedError) return error.message;
  if (error instanceof CommitUnknownError) return `${error.message}: ${describeError(error.cause)}`;
  const chain: Record<string, unknown>[] = [];
  for (let current = error, depth = 0; typeof current === "object" && current !== null && depth < 5; depth++) {
    chain.push(current as Record<string, unknown>);
    current = (current as { cause?: unknown }).cause;
  }
  const fromDatabase = chain.some(
    (e) => e.name === "DrizzleQueryError" || e.name === "PostgresError" || "query" in e || "parameters" in e,
  );
  if (!fromDatabase) return error instanceof Error ? error.message : String(error);
  const safe = (key: string) => {
    const value = chain.map((e) => e[key]).find((v) => typeof v === "string" && /^[A-Za-z0-9_.-]{1,63}$/.test(v));
    return value === undefined ? [] : [`${key} ${value as string}`];
  };
  return ["database error", ...safe("code"), ...safe("constraint_name"), ...safe("table_name")].join(", ");
}
