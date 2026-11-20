import { describe, expect, it } from "vitest";

import { createSignInLimiter } from "./sign-in-limit";

describe("createSignInLimiter", () => {
  it("blocks an email after maxFailures within the window, whatever its case", () => {
    let clock = 0;
    const limiter = createSignInLimiter({ maxFailures: 3, windowMs: 1_000, now: () => clock });
    for (let i = 0; i < 3; i++) {
      expect(limiter.acquire("Ana@example.com")).toBe(true);
      limiter.release("Ana@example.com", "failure");
    }
    expect(limiter.acquire("ana@example.com")).toBe(false);
    expect(limiter.acquire("other@example.com")).toBe(true);
    clock = 1_001;
    expect(limiter.acquire("ana@example.com")).toBe(true);
  });

  it("counts attempts in flight, so concurrent guesses can't exceed the limit", () => {
    const limiter = createSignInLimiter({ maxFailures: 3 });
    const granted = Array.from({ length: 10 }, () => limiter.acquire("ana@example.com")).filter(Boolean);
    expect(granted).toHaveLength(3);
    // An attempt that ended without a verdict (e.g. a 500) frees its slot.
    limiter.release("ana@example.com", "other");
    expect(limiter.acquire("ana@example.com")).toBe(true);
  });

  it("clears an account on success", () => {
    const limiter = createSignInLimiter({ maxFailures: 2 });
    limiter.acquire("ana@example.com");
    limiter.release("ana@example.com", "failure");
    limiter.acquire("ana@example.com");
    limiter.release("ana@example.com", "success");
    expect(limiter.acquire("ana@example.com")).toBe(true);
    expect(limiter.acquire("ana@example.com")).toBe(true);
  });

  it("never evicts a blocked account to make room, and reuses expired room", () => {
    let clock = 0;
    const limiter = createSignInLimiter({ maxFailures: 1, maxKeys: 2, windowMs: 1_000, now: () => clock });
    limiter.acquire("victim@x.com");
    limiter.release("victim@x.com", "failure");
    for (const email of ["a@x.com", "b@x.com", "c@x.com"]) {
      limiter.acquire(email);
      limiter.release(email, "failure");
    }
    expect(limiter.acquire("victim@x.com")).toBe(false);
    clock = 1_001;
    limiter.acquire("d@x.com");
    limiter.release("d@x.com", "failure");
    expect(limiter.acquire("d@x.com")).toBe(false);
  });
});
