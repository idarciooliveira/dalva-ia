import { expect, test } from "@playwright/test";

import { registerAndCompleteOnboarding } from "./helpers/auth";

test.describe("Debts page", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/debts");
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  });

  // Debts are still on Convex; PR 11 moves them to the API and restores this test.
  test.fixme("creates a debt, records a payment, and shows the ledger effects", async ({ page }) => {
    await registerAndCompleteOnboarding(page);

    await page.goto("/accounts");
    await page.getByRole("button", { name: /add account/i }).click();
    await page.getByLabel("Account name").fill("Visa Liability");
    await page.getByRole("combobox").filter({ hasText: /bank/i }).click();
    await page.getByRole("option", { name: /credit card/i }).click();
    await page.getByLabel(/opening balance/i).fill("-2000.00");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page.getByText("Visa Liability")).toBeVisible();

    await page.goto("/debts");
    await page.getByRole("button", { name: /add debt/i }).first().click();
    await page.getByLabel("Current balance").fill("2000.00");
    await page.getByLabel("Original amount").fill("2500.00");
    await page.getByLabel("Debt name").fill("Visa Platinum");
    await page.getByLabel("Lender").fill("Chase");
    await page.getByLabel("Interest rate").fill("24.99");
    await page.getByLabel("Minimum payment").fill("75.00");
    await page.getByLabel("Due date").fill("2026-05-15");

    await page.getByRole("combobox").filter({ hasText: /credit card/i }).click();
    await page.getByRole("option", { name: /credit card/i }).click();
    await page.getByRole("combobox").filter({ hasText: /no linked liability account/i }).click();
    await page.getByRole("option", { name: "Visa Liability" }).click();
    await page.getByRole("button", { name: /create debt/i }).click();

    await expect(page.getByText("Visa Platinum")).toBeVisible();
    await page.getByRole("button", { name: /visa platinum/i }).click();
    await expect(page.getByText(/chase - due may/i)).toBeVisible();

    await page.getByRole("button", { name: /record payment/i }).click();
    await page.getByLabel("Payment amount").fill("150.00");
    await page.getByRole("combobox").filter({ hasText: /select source account/i }).click();
    await page.getByRole("option", { name: "Main Checking" }).click();
    await page.getByLabel("Principal amount").fill("120.00");
    await page.getByLabel("Interest amount").fill("30.00");
    await page.getByLabel("Note").fill("April payment");
    await page.getByRole("button", { name: /record payment/i }).click();

    await expect(page.getByRole("button", { name: /record payment/i })).not.toBeVisible();
    await page.getByRole("button", { name: /visa platinum/i }).click();
    await expect(page.getByText("$150.00")).toBeVisible();
    await expect(page.getByText(/apr 7|april payment/i)).toBeVisible();

    await page.goto("/transactions");
    await expect(page.getByText(/debt payment: visa platinum/i)).toBeVisible();

    await page.goto("/dashboard");
    await expect(page.getByText(/debt paydown/i)).toBeVisible();
    await expect(page.getByText("Visa Platinum", { exact: true })).toBeVisible();
  });
});
