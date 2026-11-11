import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * convex-test generates ids as `<n>;<table>`. Real Convex ids are URL-safe,
 * and the Finance API contract rejects anything outside `[A-Za-z0-9_-]`, so
 * HTTP tests could not send or parse ids. Swap the separator for `-` (table
 * names never contain one). Test-only; fails loudly if convex-test changes.
 */
function urlSafeConvexTestIds(): Plugin {
  const replacements: Array<[string, string]> = [
    ['this._nextDocId.toString() + ";" + table', 'this._nextDocId.toString() + "-" + table'],
    ['const parts = id.split(";");', 'const parts = id.split("-");'],
    ['return id.split(";")[1];', 'return id.split("-")[1];'],
    ["idString.endsWith(`;${args.table}`)", "idString.endsWith(`-${args.table}`)"],
  ];
  return {
    name: "url-safe-convex-test-ids",
    enforce: "pre",
    transform(code, id) {
      if (!/convex-test[\\/]dist[\\/]index\.js$/.test(id)) return null;
      let out = code;
      for (const [from, to] of replacements) {
        if (!out.includes(from)) {
          throw new Error(`url-safe-convex-test-ids: pattern not found in convex-test: ${from}`);
        }
        out = out.replace(from, to);
      }
      return out;
    },
  };
}

export default defineConfig({
  plugins: [urlSafeConvexTestIds()],
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
  },
});
