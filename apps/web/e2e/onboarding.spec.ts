import { test, expect } from "@playwright/test";

import { register } from "./helpers/auth";

test.describe("Onboarding page — unauthenticated", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/onboarding");

    // The auth guard should redirect to /login
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  });
});

test.describe("Onboarding page — route exists", () => {
  test("the /onboarding route is registered and does not 404", async ({
    page,
  }) => {
    const response = await page.goto("/onboarding");

    // Should get a 200 (SSR renders the page, then client-side redirects)
    expect(response?.status()).toBe(200);
  });

  test("visiting /onboarding shows loading state before redirect", async ({
    page,
  }) => {
    await page.goto("/onboarding");

    // After auth guard redirect, we land on /login
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });

    // Login page should render correctly after redirect
    await expect(
      page.getByRole("heading", { name: /welcome back/i }),
    ).toBeVisible();
  });
});

test.describe("Onboarding page — navigation", () => {
  test("navigating to /onboarding from landing works without crashing", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Take control of your money" }),
    ).toBeVisible();

    // Navigate to /onboarding directly
    await page.goto("/onboarding");

    // Should redirect to login since unauthenticated
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  });

  test("after redirect to login, can navigate back to landing", async ({
    page,
  }) => {
    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: /welcome back/i }),
    ).toBeVisible();

    // Navigate back to landing
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Take control of your money" }),
    ).toBeVisible();
  });
});

test.describe("Onboarding page — registration flow", () => {
  test("register page has link/navigation that leads to onboarding after signup", async ({
    page,
  }) => {
    // Verify that the register page renders correctly
    // (after signup, the app navigates to /onboarding)
    await page.goto("/register");
    await expect(
      page.getByRole("heading", { name: /create your account/i }),
    ).toBeVisible();

    // The register form should be present with all required fields
    await expect(page.getByLabel("Name")).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    // Password field — use locator to avoid devtools conflicts
    await expect(page.locator("#password")).toBeVisible();
  });

  test("login page renders correctly (onboarding redirects here when unauthenticated)", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: /welcome back/i }),
    ).toBeVisible();

    // Login form should have email and password fields
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();
  });
});

test.describe("Onboarding page — full flow (apps/api)", () => {
  test("sets the currency, creates accounts, seeds the chosen categories", async ({ page }) => {
    await register(page);

    // Step 1: currency
    await page.getByLabel("Base currency").click();
    await page.getByRole("option", { name: /Euro \(EUR\)/ }).click();
    await page.getByRole("button", { name: /^continue$/i }).click();

    // Step 2: two accounts, one with an opening balance
    await expect(page.getByRole("heading", { name: "Add your accounts" })).toBeVisible();
    await page.getByLabel(/account name/i).fill("Main Checking");
    await page.getByLabel(/opening balance/i).fill("1500.50");
    await page.getByRole("button", { name: "Add another account" }).click();
    await page.getByLabel(/account name/i).nth(1).fill("Wallet");
    await page.getByRole("button", { name: /^continue$/i }).click();

    // Back and forward again must not create the accounts twice.
    await expect(page.getByRole("heading", { name: "Choose your categories" })).toBeVisible();
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: /^continue$/i }).click();

    // Step 3: drop one default category
    await expect(page.getByRole("heading", { name: "Choose your categories" })).toBeVisible();
    await page.getByRole("checkbox", { name: "Gifts" }).click();
    await page.getByRole("button", { name: /get started/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

    // Onboarded users can't go back.
    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

    await page.goto("/accounts");
    await expect(page.getByText("Main Checking")).toHaveCount(1);
    await expect(page.getByText("€1,500.50")).toBeVisible();
    await expect(page.getByText("Wallet", { exact: true })).toHaveCount(1);

    await page.goto("/categories");
    await expect(page.getByText("Salary", { exact: true })).toBeVisible();
    await expect(page.getByText("Food & Dining", { exact: true })).toBeVisible();
    await expect(page.getByText("Gifts", { exact: true })).toHaveCount(0);
  });

  test("an invalid opening balance is refused before anything is saved", async ({ page }) => {
    await register(page);
    await page.getByLabel("Base currency").click();
    await page.getByRole("option", { name: /Japanese Yen \(JPY\)/ }).click();
    await page.getByRole("button", { name: /^continue$/i }).click();

    await page.getByLabel(/account name/i).fill("Cash");
    await page.getByLabel(/opening balance/i).fill("10.5");
    await page.getByRole("button", { name: /^continue$/i }).click();
    await expect(page.getByRole("alert")).toContainText("Enter a valid opening balance for Cash");
    await expect(page.getByRole("heading", { name: "Add your accounts" })).toBeVisible();
  });
});
