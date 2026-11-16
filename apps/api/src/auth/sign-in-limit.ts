/**
 * Failed sign-ins per account, as Convex Auth limited them (10 per hour per
 * email). Better Auth only limits per client address, so many addresses could
 * keep guessing one password. In memory: the API runs as one process.
 *
 * An attempt is reserved before the password is checked, so concurrent
 * attempts can't all slip past the limit while their hashes are computed.
 */
export interface SignInLimiter {
  /** Reserve an attempt. False when the account has used up its failures (or is about to). */
  acquire(email: string): boolean;
  /** Close a reserved attempt: a failure counts, a success clears the account, anything else is dropped. */
  release(email: string, outcome: "failure" | "success" | "other"): void;
}

export interface SignInLimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  /** Bound on tracked emails. When full, new emails are not tracked; tracked ones are never evicted. */
  maxKeys?: number;
  now?: () => number;
}

interface Entry {
  /** Failure times, oldest first. */
  failures: number[];
  /** Attempts in flight. */
  pending: number;
}

export function createSignInLimiter(options: SignInLimiterOptions = {}): SignInLimiter {
  const maxFailures = options.maxFailures ?? 10;
  const windowMs = options.windowMs ?? 60 * 60 * 1000;
  const maxKeys = options.maxKeys ?? 100_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  const prune = (key: string, entry: Entry) => {
    const cutoff = now() - windowMs;
    while (entry.failures.length > 0 && entry.failures[0]! <= cutoff) entry.failures.shift();
    if (entry.failures.length === 0 && entry.pending === 0) entries.delete(key);
  };

  const sweep = () => {
    for (const [key, entry] of entries) prune(key, entry);
  };

  return {
    acquire(email) {
      const key = email.toLowerCase();
      let entry = entries.get(key);
      if (entry) prune(key, entry);
      entry = entries.get(key);
      if (!entry) {
        if (entries.size >= maxKeys) sweep();
        // Still full of live entries: let this one through untracked rather than evict a blocked account.
        if (entries.size >= maxKeys) return true;
        entry = { failures: [], pending: 0 };
        entries.set(key, entry);
      }
      if (entry.failures.length + entry.pending >= maxFailures) return false;
      entry.pending += 1;
      return true;
    },
    release(email, outcome) {
      const key = email.toLowerCase();
      const entry = entries.get(key);
      if (!entry) return;
      entry.pending = Math.max(0, entry.pending - 1);
      if (outcome === "failure") entry.failures.push(now());
      if (outcome === "success") entry.failures = [];
      prune(key, entry);
    },
  };
}
