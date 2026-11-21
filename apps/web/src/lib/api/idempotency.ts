/** JSON with object keys sorted, so equal inputs give equal strings whatever their key order. */
export function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One `Idempotency-Key` per submit: the same input gets the same key until a
 * write with it succeeds, so a retry after a timeout or a double submit replays
 * the first write instead of repeating it. A different input, or the next submit
 * after a success, gets a new key.
 */
export function createIdempotencyKeys(generate: () => string = newIdempotencyKey) {
  let current: { fingerprint: string; key: string } | null = null;
  return {
    keyFor(input: unknown): string {
      const fp = fingerprint(input ?? {});
      if (current?.fingerprint !== fp) current = { fingerprint: fp, key: generate() };
      return current.key;
    },
    /** After a success with `key`: the next submit is a new write. */
    settled(key: string) {
      if (current?.key === key) current = null;
    },
  };
}
