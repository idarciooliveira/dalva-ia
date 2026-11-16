import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: "must be a postgres:// URL" }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1, "must be 1-100").max(100, "must be 1-100").default(10),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.output<typeof configSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Validate the environment. Throws `ConfigError` naming each bad variable and
 * the rule it broke; values are never echoed, so secrets stay out of the logs.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  // Empty strings count as unset, so `FOO=` in an env file falls back to the default or fails as missing.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ""));
  const result = configSchema.safeParse(cleaned);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    const name = issue.path.join(".") || "(env)";
    const missing = issue.code === "invalid_type" && cleaned[name] === undefined;
    return `${name} ${missing ? "is required" : issue.message.startsWith("must") || issue.message.startsWith("is") ? issue.message : "is invalid"}`;
  });
  throw new ConfigError(`Invalid environment: ${problems.join("; ")}`);
}

/** The database password, for the logger's scrub list. */
export function databasePassword(config: Config): string {
  return decodeURIComponent(new URL(config.DATABASE_URL).password);
}
