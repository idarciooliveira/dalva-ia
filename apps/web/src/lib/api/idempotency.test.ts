import { describe, expect, it } from "vitest";

import { createIdempotencyKeys, fingerprint } from "./idempotency";

describe("fingerprint", () => {
  it("ignores key order", () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: [1, { f: 1, e: 2 }] } })).toBe(
      fingerprint({ b: { d: [1, { e: 2, f: 1 }], c: 2 }, a: 1 }),
    );
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

describe("createIdempotencyKeys", () => {
  let n = 0;
  const keys = () => createIdempotencyKeys(() => `key-${++n}`);

  it("reuses the key for the same input until it succeeds", () => {
    const k = keys();
    const first = k.keyFor({ name: "Main", type: "bank" });
    expect(k.keyFor({ type: "bank", name: "Main" })).toBe(first);
    k.settled(first);
    expect(k.keyFor({ name: "Main", type: "bank" })).not.toBe(first);
  });

  it("gives a different input a new key", () => {
    const k = keys();
    const first = k.keyFor({ name: "Main" });
    expect(k.keyFor({ name: "Other" })).not.toBe(first);
  });

  it("starts a new key for the same input once the reuse window has passed", () => {
    let clock = 0;
    const k = createIdempotencyKeys(() => `key-${++n}`, () => clock);
    const first = k.keyFor({ id: "a1" });
    clock = 59_000;
    expect(k.keyFor({ id: "a1" })).toBe(first);
    clock = 121_000;
    expect(k.keyFor({ id: "a1" })).not.toBe(first);
  });

  it("ignores the success of a superseded key", () => {
    const k = keys();
    const first = k.keyFor({ name: "A" });
    const second = k.keyFor({ name: "B" });
    k.settled(first);
    expect(k.keyFor({ name: "B" })).toBe(second);
  });
});
