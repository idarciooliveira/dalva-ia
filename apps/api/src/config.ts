import { z } from "zod";

import { MIN_TOKEN_SECRET_BYTES } from "./auth/tokens";

const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"], "must be development, test or production").default("development"),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: "must be a postgres:// URL" }),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1, "must be 1-100").max(100, "must be 1-100").default(10),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    /**
     * Origin users reach the app at. Web and API share it behind the proxy
     * (`/api/*` goes to the API), so session cookies are first-party. An https
     * origin makes the cookies `Secure`.
     */
    PUBLIC_URL: z
      .url({ protocol: /^https?$/, error: "must be an http(s) origin, e.g. https://dalva.example.com" })
      .refine((value) => new URL(value).origin === value.replace(/\/+$/, ""), "must be an origin, without path, query or fragment")
      .transform((value) => new URL(value).origin),
    /** Signs session cookies. Changing it signs every user out. */
    BETTER_AUTH_SECRET: z
      .string()
      .min(32, "must be at least 32 chars")
      .refine((value) => !value.includes("replace-with"), "must not be the .env.example placeholder"),
    /**
     * Signs the Finance API user tokens (HS256) the chat agent sends as
     * `Authorization: Bearer`. Same variable as on the Convex deployment.
     * Changing it invalidates every token (they live 15 minutes).
     */
    FINANCE_API_TOKEN_SECRET: z
      .string()
      .refine((value) => new TextEncoder().encode(value).length >= MIN_TOKEN_SECRET_BYTES, `must be at least ${MIN_TOKEN_SECRET_BYTES} bytes`)
      .refine((value) => !value.includes("replace-with"), "must not be the .env.example placeholder"),
    /**
     * Request header the proxy in front sets to the client's address (e.g.
     * cf-connecting-ip behind Cloudflare Tunnel). Auth rate limits are per
     * address and stay off without it: with no address every user would
     * share one bucket. Only trust a header the proxy overwrites.
     */
    CLIENT_IP_HEADER: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,64}$/, "must be a header name, e.g. cf-connecting-ip")
      .transform((value) => value.toLowerCase())
      .optional(),
  })
  .superRefine((config, ctx) => {
    if (config.FINANCE_API_TOKEN_SECRET === config.BETTER_AUTH_SECRET) {
      ctx.addIssue({ code: "custom", path: ["FINANCE_API_TOKEN_SECRET"], message: "must differ from BETTER_AUTH_SECRET" });
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

/** Values the logger scrubs from every line. */
export function configSecrets(config: Config): string[] {
  return [decodeURIComponent(new URL(config.DATABASE_URL).password), config.BETTER_AUTH_SECRET, config.FINANCE_API_TOKEN_SECRET];
}
