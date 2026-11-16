type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field values are ids, kinds, codes and counts. Never message text, tokens or keys. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/** Keys that must never reach the logs, even by mistake. */
const FORBIDDEN_KEYS = /^(text|caption|content|payload|token|secret|key|authorization|password|code|args|body|message|email|cookie)$/i;

export interface LoggerOptions {
  level: LogLevel;
  /** Strings scrubbed from every logged value (database password, auth secret). */
  secrets?: string[];
  write?: (line: string) => void;
  now?: () => Date;
}

/** Structured JSON lines on stdout. */
export function createLogger(options: LoggerOptions, base: LogFields = {}): Logger {
  const min = LEVELS[options.level];
  const secrets = (options.secrets ?? []).filter((secret) => secret.length >= 8);
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const scrub = (value: string) => secrets.reduce((acc, secret) => acc.split(secret).join("[redacted]"), value);

  const emit = (level: LogLevel, msg: string, fields: LogFields = {}) => {
    if (LEVELS[level] < min) return;
    const record: Record<string, unknown> = { ts: now().toISOString(), level, msg: scrub(msg) };
    for (const [name, value] of Object.entries({ ...base, ...fields })) {
      if (value === undefined) continue;
      if (FORBIDDEN_KEYS.test(name)) {
        record[name] = "[redacted]";
        continue;
      }
      record[name] = typeof value === "string" ? scrub(value) : value;
    }
    write(JSON.stringify(record));
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => createLogger(options, { ...base, ...fields }),
  };
}

/**
 * Loggable summary of an error: its name and code (a Postgres SQLSTATE for
 * database errors), never its message (it can quote user input, SQL or URLs).
 * Follows `cause`, since Drizzle wraps driver errors.
 */
export function errorFields(error: unknown): LogFields {
  if (typeof error !== "object" || error === null) return { errorName: typeof error };
  const { name, status } = error as { name?: unknown; status?: unknown };
  let code: unknown;
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    code = (current as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") break;
    current = (current as { cause?: unknown }).cause;
  }
  return {
    errorName: typeof name === "string" ? name : "Error",
    errorCode: typeof code === "string" || typeof code === "number" ? code : undefined,
    errorStatus: typeof status === "number" ? status : undefined,
  };
}
