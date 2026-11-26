#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { envFile, ensurePostgres, migrate, root, rootEnv } from "./lib/api-env";
import { parseEnv } from "./lib/env";

const secret = () => randomBytes(32).toString("hex");
const GENERATED = ["BETTER_AUTH_SECRET", "FINANCE_API_SERVICE_KEY"] as const;

function setVar(text: string, name: string, value: string): string {
  const line = `${name}=${/[\s#"']/.test(value) ? JSON.stringify(value) : value}`;
  const lines = text.split("\n");
  // parseEnv keeps the last active assignment, so that is the one to replace.
  const active = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=`);
  const commented = new RegExp(`^#[ \\t]*${name}=`);
  let at = lines.findLastIndex((l) => active.test(l));
  if (at < 0) at = lines.findIndex((l) => commented.test(l));
  if (at < 0) return `${text.trimEnd()}\n${line}\n`;
  lines[at] = line;
  return lines.join("\n");
}

const created = !existsSync(envFile);
let text = readFileSync(created ? join(root, ".env.example") : envFile, "utf8");

const current = parseEnv(text);
const generated: string[] = [];
for (const name of GENERATED) {
  const value = current[name];
  if (value && !value.includes("replace-with")) continue;
  text = setVar(text, name, secret());
  generated.push(name);
}
if (created || generated.length > 0) writeFileSync(envFile, text, { mode: 0o600 });

console.log(
  created
    ? `setup: created .env${generated.length > 0 ? ` (${generated.join(", ")} generated)` : ""}`
    : generated.length > 0
      ? `setup: generated ${generated.join(", ")} in .env`
      : "setup: .env already complete",
);

const databaseUrl = rootEnv().DATABASE_URL;
if (!databaseUrl) {
  console.error("setup: DATABASE_URL is missing from .env");
  process.exit(1);
}
await ensurePostgres(databaseUrl, "setup");
migrate("setup");
console.log("setup: database migrated");

console.log("\nDone. Start everything with: bun run dev");
console.log("The first user to sign up owns this DALVA: set the Telegram bot and AI provider in Settings → Assistant setup.");
