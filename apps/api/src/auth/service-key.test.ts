import { describe, expect, it } from "vitest";

import { createServiceKey } from "./service-key";

describe("service key", () => {
  const key = createServiceKey("k".repeat(32));

  it("matches only the exact key", () => {
    expect(key.matches("k".repeat(32))).toBe(true);
    for (const other of ["", "k".repeat(31), "k".repeat(33), `${"k".repeat(31)}K`]) expect(key.matches(other)).toBe(false);
  });

  it("refuses keys under 32 bytes", () => {
    expect(() => createServiceKey("short")).toThrow("at least 32 bytes");
  });
});
