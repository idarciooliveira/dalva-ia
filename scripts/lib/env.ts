import { existsSync, readFileSync } from "node:fs";

export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(.*?))\s*(?:\s#.*)?$/);
    if (match) env[match[1]!] = match[2] ?? match[3] ?? match[4]!.replace(/^#.*$/, "");
  }
  return env;
}

export function readEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
}
