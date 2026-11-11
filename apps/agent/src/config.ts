import { z } from "zod";

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

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
    RECOVERY_MAX_AGE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(120),
    // Chat agent (LLM). The model id is provider-specific and has no default on purpose.
    AI_PROVIDER: z.enum(["gateway", "openrouter"], "must be gateway or openrouter"),
    AGENT_MODEL: z.string().regex(/^[A-Za-z0-9._:/@+-]{1,200}$/, "must be a provider/model id"),
    AI_GATEWAY_API_KEY: z.string().min(8, "must be at least 8 chars").optional(),
    OPENROUTER_API_KEY: z.string().min(8, "must be at least 8 chars").optional(),
    AGENT_MAX_STEPS: z.coerce.number().int().min(1, "must be 1-10").max(10, "must be 1-10").default(6),
    AGENT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64, "must be 64-8192").max(8192, "must be 64-8192").optional(),
    AGENT_TURN_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(300).default(45),
    AGENT_RATE_LIMIT_TURNS: z.coerce.number().int().min(1).max(1000).default(20),
    AGENT_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
    DEFAULT_TIMEZONE: z.string().refine(isTimeZone, "must be an IANA time zone, e.g. Africa/Luanda").default("Africa/Luanda"),
  })
  .superRefine((config, ctx) => {
    if (config.TELEGRAM_MODE === "webhook" && !config.TELEGRAM_WEBHOOK_SECRET) {
      ctx.addIssue({ code: "custom", path: ["TELEGRAM_WEBHOOK_SECRET"], message: "is required in webhook mode" });
    }
    if (config.AI_PROVIDER === "gateway" && !config.AI_GATEWAY_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["AI_GATEWAY_API_KEY"], message: "is required when AI_PROVIDER=gateway" });
    }
    if (config.AI_PROVIDER === "openrouter" && !config.OPENROUTER_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["OPENROUTER_API_KEY"], message: "is required when AI_PROVIDER=openrouter" });
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

/** The configured provider's key. Only `src/llm` turns it into a model. */
export function modelSettings(config: Config): { provider: Config["AI_PROVIDER"]; modelId: string; apiKey: string } {
  const apiKey = config.AI_PROVIDER === "gateway" ? config.AI_GATEWAY_API_KEY : config.OPENROUTER_API_KEY;
  // loadConfig guarantees the selected provider's key.
  return { provider: config.AI_PROVIDER, modelId: config.AGENT_MODEL, apiKey: apiKey! };
}
