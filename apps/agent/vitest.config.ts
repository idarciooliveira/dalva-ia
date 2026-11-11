import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      // Bun bundles `import x from "./file.md" with { type: "text" }` as a string; do the same under Vitest.
      name: "text-md",
      transform(code, id) {
        if (id.endsWith(".md")) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
