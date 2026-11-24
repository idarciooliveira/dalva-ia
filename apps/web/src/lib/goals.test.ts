import type { Goal } from "@/lib/api/types";
import { describe, expect, it } from "vitest";

import { DEFAULT_GOAL_COLOR, goalChanges } from "./goals";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });
const goal = {
  id: "g1",
  name: "Trip",
  targetAmount: usd(100000),
  currentAmount: usd(25000),
  targetDate: "2027-06-01",
  isVirtual: true,
  createdAt: "2026-01-01",
} as unknown as Goal;
const same = { name: "Trip", targetAmount: usd(100000), targetDate: "2027-06-01", color: DEFAULT_GOAL_COLOR };

describe("goalChanges", () => {
  it("is null when nothing changed (no color stored means the default)", () => {
    expect(goalChanges(goal, same)).toBeNull();
  });

  it("sends only the changed fields", () => {
    expect(goalChanges(goal, { ...same, name: "Summer trip", targetAmount: usd(200000) })).toEqual({
      name: "Summer trip",
      targetAmount: usd(200000),
      targetDate: undefined,
      color: undefined,
    });
    expect(goalChanges(goal, { ...same, color: "#34d399" })).toMatchObject({ color: "#34d399", name: undefined });
  });

  it("never sends a blank date (the API can't clear it)", () => {
    expect(goalChanges(goal, { ...same, targetDate: undefined })).toBeNull();
  });
});
