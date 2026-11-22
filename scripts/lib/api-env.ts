import { createConnection } from "node:net";
import { join } from "node:path";

import { readEnvFile } from "./env";

export const root = join(import.meta.dir, "../..");
export const apiDir = join(root, "apps/api");

/** apps/api's env as Bun loads it there: .env.local over .env. */
export function apiEnv(): Record<string, string> {
  return { ...readEnvFile(join(apiDir, ".env")), ...readEnvFile(join(apiDir, ".env.local")) };
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 1_000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * Postgres for DATABASE_URL: already listening (compose or any other server), or
 * started from compose.dev.yml. Exits with a hint when neither works.
 */
export async function ensurePostgres(databaseUrl: string, label: string): Promise<void> {
  const url = new URL(databaseUrl);
  const host = url.hostname;
  const port = Number(url.port || 5432);
  if (await reachable(host, port)) return;

  console.log(`${label}: Postgres not answering on ${host}:${port}, starting compose.dev.yml`);
  let started = false;
  try {
    const compose = Bun.spawnSync(["docker", "compose", "-f", "compose.dev.yml", "up", "-d", "--wait"], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    });
    started = compose.exitCode === 0;
  } catch {
    // No docker binary: fall through to the hint.
  }
  if (started && (await reachable(host, port))) return;
  console.error(
    `${label}: no Postgres on ${host}:${port}. Start Docker and run \`docker compose -f compose.dev.yml up -d\`, ` +
      "or point DATABASE_URL in apps/api/.env.local at a running server.",
  );
  process.exit(1);
}

export function migrate(label: string): void {
  const result = Bun.spawnSync(["bun", "run", "db:migrate"], { cwd: apiDir, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    console.error(`${label}: migrations failed`);
    process.exit(1);
  }
}
