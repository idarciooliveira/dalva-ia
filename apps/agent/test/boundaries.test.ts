import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("module boundaries", () => {
  test("only src/channels/telegram imports grammY or Telegram types", () => {
    const offenders = files(SRC)
      .filter((path) => !relative(SRC, path).startsWith(join("channels", "telegram")))
      .filter((path) => /from\s+["'](grammy|@grammyjs)[^"']*["']/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  test("core never imports the telegram adapter", () => {
    const offenders = files(join(SRC, "core"))
      .filter((path) => /channels\/telegram/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  test("nothing imports Convex", () => {
    const offenders = files(SRC).filter((path) => /from\s+["'](convex|@mpf\/backend)/.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
