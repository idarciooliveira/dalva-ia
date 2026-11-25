import { z } from "zod";

import { MIN_SERVICE_KEY_BYTES } from "./auth/service-key";

const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"], "must be development, test or production").default("development"),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: "must be a postgres:// URL" }),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1, "must be 1-100").max(100, "must be 1-100").default(10),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    PUBLIC_URL: z
      .url({ protocol: /^https?$/, error: "must be an http(s) origin, e.g. https://dalva.example.com" })
      .refine((value) => new URL(value).origin === value.replace(/\/+$/, ""), "must be an origin, without path, query or fragment")
      .transform((value) => new URL(value).origin),
    BETTER_AUTH_SECRET: z
      .string()
      .min(32, "must be at least 32 chars")
      .refine((value) => !value.includes("replace-with"), "must not be the .env.example placeholder"),
    FINANCE_API_SERVICE_KEY: z
      .string()
      .refine((value) => new TextEncoder().encode(value).length >= MIN_SERVICE_KEY_BYTES, `must be at least ${MIN_SERVICE_KEY_BYTES} bytes`)
      .refine((value) => !value.includes("replace-with"), "must not be the .env.example placeholder")
      .optional(),
    TELEGRAM_BOT_USERNAME: z
      .string()
      .transform((value) => value.replace(/^@/, ""))
      .pipe(z.string().regex(/^[A-Za-z0-9_]{5,32}$/, "must be a Telegram username"))
      .optional(),
    CLIENT_IP_HEADER: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,64}$/, "must be a header name, e.g. cf-connecting-ip")
      .transform((value) => value.toLowerCase())
      .optional(),
  })
  .superRefine((config, ctx) => {
    if (config.FINANCE_API_SERVICE_KEY !== undefined && config.FINANCE_API_SERVICE_KEY === config.BETTER_AUTH_SECRET) {
      ctx.addIssue({ code: "custom", path: ["FINANCE_API_SERVICE_KEY"], message: "must differ from BETTER_AUTH_SECRET" });
    }
    if (config.NODE_ENV === "production" && !config.FINANCE_API_SERVICE_KEY) {
      ctx.addIssue({ code: "custom", path: ["FINANCE_API_SERVICE_KEY"], message: "is required in production (chat agent)" });
    }
    if (config.NODE_ENV === "production" && !config.PUBLIC_URL.startsWith("https:")) {
      ctx.addIssue({ code: "custom", path: ["PUBLIC_URL"], message: "must be https in production" });
    }
    if (config.NODE_ENV === "production" && !config.CLIENT_IP_HEADER) {
      ctx.addIssue({ code: "custom", path: ["CLIENT_IP_HEADER"], message: "is required in production (auth rate limits)" });
    }
  });

export type Config = z.output<typeof configSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: Record<string, string | undefined>): Config {
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

export function configSecrets(config: Config): string[] {
  return [
    decodeURIComponent(new URL(config.DATABASE_URL).password),
    config.BETTER_AUTH_SECRET,
    ...(config.FINANCE_API_SERVICE_KEY ? [config.FINANCE_API_SERVICE_KEY] : []),
  ];
}
