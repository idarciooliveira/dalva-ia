import { expect, test } from "@playwright/test";

import { newUser, registerAndCompleteOnboarding } from "./helpers/auth";

/**
 * Pages still on Convex until PRs 10-11 load no data on main, but must render
 * inside the shell without crashing. Delete each entry when its page moves.
 */
const LEGACY_PAGES = [
  { path: "/dashboard", heading: /, Legacy$/ }, // PR 10
  { path: "/transactions", heading: "Transactions" }, // PR 10
  { path: "/goals", heading: "Savings Goals" }, // PR 11
  { path: "/debts", heading: "Debts" }, // PR 11
  { path: "/settings", heading: "Settings" }, // PR 11
];

test("pages not migrated yet render without crashing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await registerAndCompleteOnboarding(page, newUser("Legacy Tester"));

  for (const { path, heading } of LEGACY_PAGES) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  }
  expect(errors).toEqual([]);
});
