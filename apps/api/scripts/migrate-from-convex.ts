/**
 * Import a Convex export into an empty, migrated Postgres database.
 *
 *   bun run migrate:convex <export.zip | export-dir> [--dry-run] [--drop-invalid] [--accept-lone-legs] [--report <file>]
 *
 * DATABASE_URL: the target. Required for a real run. A dry run with it writes
 * and verifies inside a transaction it rolls back; without it, only the export
 * is checked. Summary on stderr; the full JSON report (Convex ids and counts,
 * no emails or names) to --report, else stdout.
 *
 * Exit codes: 0 success, 1 errors / refused / verification failed, 2 usage.
 * See docs/deploy.md, "Cutover".
 */
import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { createDatabase } from "../src/db/client";
import { describeError, formatSummary, importSucceeded, runImport } from "../src/import/run";
import { CommitUnknownError } from "../src/import/write";

const USAGE = "usage: bun run migrate:convex <export.zip | export-dir> [--dry-run] [--drop-invalid] [--accept-lone-legs] [--report <file>]";

let args: ReturnType<typeof parse>;
function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      "drop-invalid": { type: "boolean", default: false },
      "accept-lone-legs": { type: "boolean", default: false },
      report: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
}
try {
  args = parse();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n${USAGE}\n`);
  process.exit(2);
}
if (args.values.help || args.positionals.length !== 1) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(args.values.help ? 0 : 2);
}

const dryRun = args.values["dry-run"];
const url = process.env.DATABASE_URL || undefined;
if (url && !/^postgres(ql)?:\/\//.test(url)) {
  process.stderr.write("DATABASE_URL must be a postgres:// URL\n");
  process.exit(2);
}
if (!dryRun && !url) {
  process.stderr.write("DATABASE_URL is required for a real run (or pass --dry-run)\n");
  process.exit(2);
}

// The report must never replace the export it was made from (the zip, or a file in the export directory).
const source = resolve(args.positionals[0]!);
if (args.values.report) {
  const fromSource = relative(source, resolve(args.values.report));
  if (fromSource === "" || (!fromSource.startsWith("..") && !fromSource.startsWith("/"))) {
    process.stderr.write("--report must be outside the export\n");
    process.exit(2);
  }
}

/** Write the report private from its first byte: a new 0600 file, renamed over any existing one. */
async function writePrivate(path: string, content: string) {
  const temp = join(dirname(path), `.${randomBytes(6).toString("hex")}.report.tmp`);
  try {
    await writeFile(temp, content, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

const handle = url ? createDatabase({ url, max: 1 }) : undefined;
let exitCode = 1;
try {
  const report = await runImport({
    source,
    db: handle?.db,
    dryRun,
    dropInvalid: args.values["drop-invalid"],
    acceptLoneLegs: args.values["accept-lone-legs"],
  });
  process.stderr.write(`${formatSummary(report)}\n`);
  exitCode = importSucceeded(report) ? 0 : 1;
  const json = `${JSON.stringify(report, null, 2)}\n`;
  try {
    if (args.values.report) await writePrivate(args.values.report, json);
    else process.stdout.write(json);
  } catch (error) {
    // The import's outcome stands (see the summary); only the report is missing.
    process.stderr.write(`report not written: ${(error as Error).message}\n`);
    exitCode = 1;
  }
} catch (error) {
  process.stderr.write(
    error instanceof CommitUnknownError
      ? `import outcome unknown, the commit may have landed: ${describeError(error)}\nCheck the target database before retrying.\n`
      : `import failed, nothing committed: ${describeError(error)}\n`,
  );
} finally {
  await handle?.close();
}
process.exit(exitCode);
