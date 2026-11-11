import { z } from "zod";

const configSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z.string().regex(/^\d{1,20}:[A-Za-z0-9_-]{30,64}$/, "must look like <id>:<secret> from BotFather"),
    TELEGRAM_WEBHOOK_SECRET: z
      .string()
      .regex(/^[A-Za-z0-9_-]{32,256}$/, "must be 32-256 chars of A-Z a-z 0-9 _ -")
      .optional(),
    TELEGRAM_MODE: z.enum(["webhook", "polling"]),
    TELEGRAM_BOT_USERNAME: z
      .string()
      .transform((value) => value.replace(/^@/, ""))
      .pipe(z.string().regex(/^[A-Za-z0-9_]{5,32}$/, "must be a Telegram username")),
    FINANCE_API_URL: z.url({ protocol: /^https?$/ }).transform((value) => value.replace(/\/+$/, "")),
    FINANCE_API_SERVICE_KEY: z.string().min(32, "must be at least 32 chars"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  })
  .superRefine((config, ctx) => {
    if (config.TELEGRAM_MODE === "webhook" && !config.TELEGRAM_WEBHOOK_SECRET) {
      ctx.addIssue({ code: "custom", path: ["TELEGRAM_WEBHOOK_SECRET"], message: "is required in webhook mode" });
    }
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
