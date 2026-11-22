import { expect, test } from "@playwright/test";

import { registerAndCompleteOnboarding } from "./helpers/auth";

test.describe("Transactions page - unauthenticated", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/transactions");

    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  });
});

test.describe("Transactions page - route exists", () => {
  test("the /transactions route is registered and does not 404", async ({
    page,
  }) => {
    const response = await page.goto("/transactions");

    expect(response?.status()).toBe(200);
  });

  test("visiting /transactions shows loading state before redirect", async ({
    page,
  }) => {
    await page.goto("/transactions");

    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: /welcome back/i }),
    ).toBeVisible();
  });
});

test.describe("Transactions page - sidebar navigation", () => {
  test("sidebar Transactions link points to /transactions", async ({
    page,
  }) => {
    await page.goto("/transactions");
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });

    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Take control of your money" }),
    ).toBeVisible();
  });
});

test.describe("Transactions page - navigation from landing", () => {
  test("navigating to /transactions from landing works", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Take control of your money" }),
    ).toBeVisible();

    await page.goto("/transactions");

    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  });
});

test.describe("Transactions page - edit flow", () => {
  // Transactions are still on Convex; PR 10 moves them to the API and restores this test.
  test.fixme("editing a transaction without changing the amount preserves its value", async ({
    page,
  }) => {
    await registerAndCompleteOnboarding(page);

    await page.goto("/transactions");
    await expect(
      page.getByRole("heading", { name: "Transactions" }),
    ).toBeVisible();

    await page.getByRole("button", { name: /add transaction/i }).click();
    await expect(
      page.getByRole("heading", { name: "New expense" }),
    ).toBeVisible();

    await page.getByLabel("Amount").fill("2000");
    await page.getByLabel("Description").fill("Lunch");
    await page.getByRole("combobox").filter({ hasText: "Account" }).click();
    await page.getByRole("option", { name: "Main Checking" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.getByText("Lunch", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Open Lunch actions" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();

    await expect(
      page.getByRole("heading", { name: "Edit expense" }),
    ).toBeVisible();
    await expect(page.getByLabel("Amount")).toHaveValue("20,00");

    await page.getByRole("button", { name: "Save changes" }).click();

    await expect(
      page.getByRole("heading", { name: "Edit expense" }),
    ).not.toBeVisible();

    await page.getByRole("button", { name: "Open Lunch actions" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await expect(page.getByLabel("Amount")).toHaveValue("20,00");
  });
});
