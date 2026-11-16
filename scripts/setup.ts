#!/usr/bin/env bun
// One-time local setup, safe to re-run: `bun run setup` from the repo root.
//
// 1. Creates a local Convex deployment (refuses to touch a cloud one).
// 2. Sets the backend env vars that are missing: auth keys, SITE_URL, Finance API secrets.
// 3. Writes apps/agent/.env.local so the bot talks to the local backend.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const backendDir = join(root, "packages/backend");
const backendEnvFile = join(backendDir, ".env.local");
const agentDir = join(root, "apps/agent");
const SITE_URL = "http://localhost:3000";

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*(#.*)?$/);
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

function convex(args: string[], interactive = false): string {
  const result = Bun.spawnSync(["bunx", "convex", ...args], {
    cwd: backendDir,
    stdin: "inherit",
    stdout: interactive ? "inherit" : "pipe",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    console.error(`\nsetup: \`convex ${args[0]} ${args[1] ?? ""}\` failed (exit ${result.exitCode}).`);
    process.exit(1);
  }
  return interactive ? "" : result.stdout.toString();
}

function randomSecret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64");
}

// Same output as `npx @convex-dev/auth`: an RS256 key pair, private key as single-line PKCS#8 PEM.
async function authKeys(): Promise<{ JWT_PRIVATE_KEY: string; JWKS: string }> {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY----- ${pkcs8.match(/.{1,64}/g)!.join(" ")} -----END PRIVATE KEY-----`;
  const { kty, n, e } = await crypto.subtle.exportKey("jwk", publicKey);
  return { JWT_PRIVATE_KEY: pem, JWKS: JSON.stringify({ keys: [{ use: "sig", alg: "RS256", kty, n, e }] }) };
}

// 1. Local deployment.
let deployment = readEnvFile(backendEnvFile).CONVEX_DEPLOYMENT;
if (!deployment) {
  console.log("setup: creating a local Convex deployment (convex dev --local --once)\n");
  convex(["dev", "--local", "--once"], true);
  deployment = readEnvFile(backendEnvFile).CONVEX_DEPLOYMENT;
}
if (!deployment?.startsWith("local:")) {
  console.error(
    `setup: packages/backend/.env.local points at "${deployment ?? "nothing"}", not a local deployment.\n` +
      "This script only configures local deployments. To switch, delete packages/backend/.env.local and re-run.",
  );
  process.exit(1);
}
console.log(`setup: using ${deployment}`);

// 2. Backend env vars, only the missing ones.
const existing = new Set(
  convex(["env", "list"])
    .split("\n")
    .map((line) => line.split("=")[0])
    .filter(Boolean),
);
const wanted: Record<string, () => string | Promise<string>> = {
  SITE_URL: () => SITE_URL,
  FINANCE_API_TOKEN_SECRET: randomSecret,
  FINANCE_API_SERVICE_KEY: randomSecret,
};
const missingKeys = !existing.has("JWT_PRIVATE_KEY") || !existing.has("JWKS");
const toSet: Record<string, string> = missingKeys ? await authKeys() : {};
for (const [name, make] of Object.entries(wanted)) {
  if (!existing.has(name)) toSet[name] = await make();
}
for (const [name, value] of Object.entries(toSet)) {
  convex(["env", "set", name, "--", value]);
}
console.log(
  Object.keys(toSet).length
    ? `setup: set ${Object.keys(toSet).join(", ")}`
    : "setup: backend env vars already set",
);

// 3. Agent overrides. Bun loads .env.local over .env, so the bot uses the local backend
//    while apps/agent/.env keeps the Telegram and LLM keys.
const siteUrl = readEnvFile(backendEnvFile).VITE_CONVEX_SITE_URL;
if (!siteUrl) {
  console.error("setup: VITE_CONVEX_SITE_URL missing from packages/backend/.env.local. Run `bun run dev:backend` once.");
  process.exit(1);
}
const serviceKey = convex(["env", "get", "FINANCE_API_SERVICE_KEY"]).trim();
writeFileSync(
  join(agentDir, ".env.local"),
  "# Written by `bun run setup`. Points the bot at the local Convex backend; overrides apps/agent/.env.\n" +
    `FINANCE_API_URL=${siteUrl}\nFINANCE_API_SERVICE_KEY=${serviceKey}\n`,
  { mode: 0o600 },
);
console.log("setup: wrote apps/agent/.env.local");

const agentEnv = join(agentDir, ".env");
if (!existsSync(agentEnv)) {
  writeFileSync(agentEnv, readFileSync(join(agentDir, ".env.example"), "utf8"), { mode: 0o600 });
  console.log("setup: created apps/agent/.env from .env.example. Fill TELEGRAM_BOT_TOKEN and an LLM key to run the bot.");
}

console.log("\nDone. Start everything with: bun run dev");
