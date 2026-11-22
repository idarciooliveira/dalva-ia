import { existsSync, readFileSync } from "node:fs";

/** `KEY=value` lines, `export` allowed. Quoted values keep `#`; unquoted ones end at ` #`. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(.*?))\s*(?:\s#.*)?$/);
    if (match) env[match[1]!] = match[2] ?? match[3] ?? match[4]!.replace(/^#.*$/, "");
  }
  return env;
}
