import { describe, expect, it } from "vitest";

import { formatMonthYear, localToday } from "./dates";

describe("localToday", () => {
  it("uses the local calendar day, not the UTC one", () => {
    // 23:30 local time on the 5th: still the 5th whatever the offset.
    expect(localToday(new Date(2026, 4, 5, 23, 30))).toBe("2026-05-05");
    expect(localToday(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01");
  });
});

describe("formatMonthYear", () => {
  it("formats a calendar date without shifting it", () => {
    expect(formatMonthYear("2026-05-01")).toBe("May 2026");
  });
});
