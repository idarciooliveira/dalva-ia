import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` diffs the schema against the snapshots in ./drizzle; it needs no database.
// Migrations are applied by `bun run db:migrate` (src/db/migrate-cli.ts), not by drizzle-kit.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
