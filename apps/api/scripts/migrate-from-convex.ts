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
import { chmod, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { createDatabase } from "../src/db/client";
import { describeError, formatSummary, importSucceeded, runImport } from "../src/import/run";

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

const handle = url ? createDatabase({ url, max: 1 }) : undefined;
let exitCode = 1;
try {
  const report = await runImport({
    source: args.positionals[0]!,
    db: handle?.db,
    dryRun,
    dropInvalid: args.values["drop-invalid"],
    acceptLoneLegs: args.values["accept-lone-legs"],
  });
  process.stderr.write(`${formatSummary(report)}\n`);
  exitCode = importSucceeded(report) ? 0 : 1;
  const json = `${JSON.stringify(report, null, 2)}\n`;
  try {
    if (args.values.report) {
      await writeFile(args.values.report, json, { mode: 0o600 });
      await chmod(args.values.report, 0o600); // also when the file already existed
    }
    else process.stdout.write(json);
  } catch (error) {
    // The import's outcome stands (see the summary); only the report is missing.
    process.stderr.write(`report not written: ${(error as Error).message}\n`);
    exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`import failed, nothing committed: ${describeError(error)}\n`);
} finally {
  await handle?.close();
}
process.exit(exitCode);
