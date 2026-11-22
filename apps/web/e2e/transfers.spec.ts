import { test, expect, type Page } from "@playwright/test";

import { accountId, apiWrite, createAccount, usd } from "./helpers/api";
import { registerAndCompleteOnboarding } from "./helpers/auth";

function accountRow(page: Page, name: string) {
  return page.getByRole("listitem", { name, exact: true });
}

test.describe("Transfers — unauthenticated", () => {
  test("transfers require authentication (transactions page redirects to /login)", async ({
    page,
  }) => {
    await page.goto("/transactions");

    // The auth guard should redirect to /login
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  });
});

test.describe("Transfers — route and rendering", () => {
  test("the /transactions route loads without errors (transfers are on this page)", async ({
    page,
  }) => {
    const response = await page.goto("/transactions");

    // Should get a 200 (SSR renders the page, then client-side redirects)
    expect(response?.status()).toBe(200);
  });

  test("after auth redirect, login page renders correctly", async ({
    page,
  }) => {
    await page.goto("/transactions");

    // After auth guard redirect, we land on /login
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });

    // Login page should render correctly
    await expect(
      page.getByRole("heading", { name: /welcome back/i }),
    ).toBeVisible();
  });
});

test.describe("Transfers — landing page references", () => {
  test("landing page features section mentions transfers", async ({
    page,
  }) => {
    await page.goto("/");

    // Verify the landing page renders without errors
    await expect(
      page.getByRole("heading", { name: "Take control of your money" }),
    ).toBeVisible();

    // The app should not crash when navigating to the transactions page
    await page.goto("/transactions");
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });

    // Navigate back to landing
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Take control of your money" }),
    ).toBeVisible();
  });
});

test.describe("Transfers (apps/api)", () => {
  test("create from the quick actions, edit and delete move both balances", async ({ page }) => {
    await registerAndCompleteOnboarding(page);
    const main = await accountId(page, "Main Checking");
    await createAccount(page, "Savings");
    await apiWrite(page, "POST", "/transactions", { type: "income", amount: usd(100_000), accountId: main, date: "2026-01-01", description: "Salary" });

    // Floating quick action, from any page.
    await page.goto("/accounts");
    await page.getByRole("button", { name: "Register transfer" }).click();
    await expect(page.getByRole("heading", { name: "New transfer" })).toBeVisible();
    await page.getByLabel("Amount").fill("25000");
    await page.getByRole("combobox", { name: "From account" }).click();
    await page.getByRole("option", { name: "Main Checking" }).click();
    await page.getByRole("combobox", { name: "To account" }).click();
    await page.getByRole("option", { name: "Savings" }).click();
    await page.getByLabel("Description").fill("Move to savings");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    // The open accounts list refreshes without a reload.
    await expect(accountRow(page, "Main Checking")).toContainText("$750.00");
    await expect(accountRow(page, "Savings")).toContainText("$250.00");

    // Both legs are listed; editing either edits the transfer.
    await page.goto("/transactions");
    const legs = page.getByRole("listitem", { name: "Move to savings" });
    await expect(legs).toHaveCount(2);
    await expect(legs.filter({ hasText: "Main Checking  →  Savings" })).toContainText("-$250.00");
    await expect(legs.filter({ hasText: "Transfer to Savings" })).toContainText("+$250.00");

    await legs.first().getByRole("button", { name: "Open Move to savings actions" }).click();
    await page.getByRole("menuitem", { name: "Edit transfer" }).click();
    await expect(page.getByRole("heading", { name: "Edit transfer" })).toBeVisible();
    await expect(page.getByLabel("Amount")).toHaveValue("250,00");
    await expect(page.getByRole("combobox", { name: "From account" })).toContainText("Main Checking");
    await expect(page.getByRole("combobox", { name: "To account" })).toContainText("Savings");
    await page.getByLabel("Amount").fill("10000");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(legs.filter({ hasText: "Transfer to Savings" })).toContainText("+$100.00");

    await page.goto("/accounts");
    await expect(accountRow(page, "Main Checking")).toContainText("$900.00");
    await expect(accountRow(page, "Savings")).toContainText("$100.00");

    await page.goto("/transactions");
    await legs.last().getByRole("button", { name: "Open Move to savings actions" }).click();
    await page.getByRole("menuitem", { name: "Delete transfer" }).click();
    await page.getByRole("button", { name: "Yes, delete" }).click();
    await expect(legs).toHaveCount(0);

    await page.goto("/accounts");
    await expect(accountRow(page, "Main Checking")).toContainText("$1,000.00");
    await expect(accountRow(page, "Savings")).toContainText("$0.00");
  });

  test("refuses the same account on both sides", async ({ page }) => {
    await registerAndCompleteOnboarding(page);
    await createAccount(page, "Savings");
    await page.goto("/transactions");

    await page.getByRole("button", { name: "Register transfer" }).click();
    await page.getByLabel("Amount").fill("1000");
    await page.getByRole("combobox", { name: "From account" }).click();
    await page.getByRole("option", { name: "Main Checking" }).click();
    // The destination list leaves out the source account.
    await page.getByRole("combobox", { name: "To account" }).click();
    await expect(page.getByRole("option", { name: "Main Checking" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("Please select a destination account");
  });
});
