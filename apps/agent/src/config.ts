import { z } from "zod";

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The agent's environment: where the API is and its service key, plus tuning.
 * The bot token, webhook secret, bot username and AI provider are not here:
 * the instance owner sets them in the web app and the agent reads them from
 * the API (`instance.agentConfig`, see `src/core/remote-config.ts`).
 */
const configSchema = z
  .object({
    FINANCE_API_URL: z.url({ protocol: /^https?$/ }).transform((value) => value.replace(/\/+$/, "")),
    FINANCE_API_SERVICE_KEY: z.string().min(32, "must be at least 32 chars"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
    RECOVERY_MAX_AGE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(120),
    AGENT_MAX_STEPS: z.coerce.number().int().min(1, "must be 1-10").max(10, "must be 1-10").default(6),
    AGENT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64, "must be 64-8192").max(8192, "must be 64-8192").default(1024),
    AGENT_TURN_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(300).default(45),
    AGENT_RATE_LIMIT_TURNS: z.coerce.number().int().min(1).max(1000).default(20),
    AGENT_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
    DEFAULT_TIMEZONE: z.string().refine(isTimeZone, "must be an IANA time zone, e.g. Africa/Luanda").default("Africa/Luanda"),
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
    return `${name} ${missing ? "is required" : (issue.message.startsWith("must") || issue.message.startsWith("is") ? issue.message : "is invalid")}`;
  });
  throw new ConfigError(`Invalid environment: ${problems.join("; ")}`);
}
