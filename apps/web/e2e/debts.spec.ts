import { expect, test } from "@playwright/test";

import { accountRow, createAccount } from "./helpers/accounts";
import { registerAndCompleteOnboarding } from "./helpers/auth";

test.describe("Debts page", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/debts");
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  });

  test("creates a debt, records and removes a payment, with the balance effects", async ({ page }) => {
    // Long flow across several pages.
    test.slow();
    await registerAndCompleteOnboarding(page);
    await createAccount(page, { name: "Visa Liability", type: /credit card/i, balanceMinor: "-200000" });
    // Not in the base currency (USD): the pickers leave it out.
    await createAccount(page, { name: "Euro Card", type: /credit card/i, currency: /EUR — Euro/ });

    await page.getByRole("link", { name: "Debts" }).click();
    await expect(page.getByText("No debts yet")).toBeVisible();
    await page.getByRole("button", { name: /add debt/i }).click();
    await page.getByLabel("Current balance").fill("200000");
    await page.getByLabel("Original amount").fill("250000");
    await page.getByLabel("Debt name").fill("Visa Platinum");
    await page.getByLabel("Lender").fill("Chase");
    await page.getByLabel("Interest rate").fill("24.99");
    await page.getByLabel("Minimum payment").fill("7500");
    await page.getByLabel("Due date").fill("2026-05-15");
    await expect(page.getByRole("combobox", { name: "Debt type" })).toHaveText(/credit card/i);
    await page.getByRole("combobox", { name: "Linked liability account" }).click();
    await expect(page.getByRole("option", { name: "Euro Card" })).toHaveCount(0);
    await page.getByRole("option", { name: "Visa Liability" }).click();
    await expect(page.getByText(/only accounts in USD/i)).toBeVisible();
    await page.getByRole("button", { name: /create debt/i }).click();
    await expect(page.getByRole("heading", { name: "New debt" })).toBeHidden();

    const card = page.getByRole("button", { name: /visa platinum/i });
    await expect(card).toContainText("20%");
    await expect(card).toContainText("$2,000.00 remaining");
    // Debt summary (a report): remaining, paid off of the original, last payment.
    const summary = page.getByLabel("Debt summary");
    await expect(summary).toContainText("$2,000.00");
    await expect(summary).toContainText("$500.00 · 20%");
    await expect(summary).toContainText("None yet");

    await card.click();
    const detail = page.getByRole("dialog");
    await expect(detail).toContainText(/chase - due may 15/i);
    await expect(detail).toContainText("24.99%");
    await expect(detail).toContainText("$75.00");

    await detail.getByRole("button", { name: /record payment/i }).click();
    await page.getByLabel("Payment amount").fill("15000");
    await page.getByRole("combobox", { name: "Source account" }).click();
    // Never the liability the payment pays down, never another currency.
    await expect(page.getByRole("option", { name: "Visa Liability" })).toHaveCount(0);
    await expect(page.getByRole("option", { name: "Euro Card" })).toHaveCount(0);
    await page.getByRole("option", { name: "Main Checking" }).click();
    await page.getByLabel("Principal amount").fill("12000");
    // Interest left blank: the rest of the payment.
    await page.getByLabel("Note").fill("April payment");
    await page.getByRole("button", { name: /record payment/i }).click();
    await expect(page.getByRole("heading", { name: "Record payment" })).toBeHidden();

    // The principal pays the debt down.
    await expect(card).toContainText("$1,880.00 remaining");
    await expect(summary).toContainText("$150.00");
    await card.click();
    const payments = page.getByRole("list", { name: "Payments" });
    await expect(payments).toContainText("$150.00");
    await expect(payments).toContainText("$30.00 interest");
    await expect(payments).toContainText("April payment");
    await page.keyboard.press("Escape");

    // The payment left Main Checking. (The linked liability gets `balance - principal`, as under
    // Convex: right for a positive balance owed, the wrong way for a negative one. Not asserted here.)
    await expect(await accountRow(page, "Main Checking")).toContainText("$150.00");
    await expect(await accountRow(page, "Visa Liability")).not.toContainText("$2,000.00");

    // Removing it reverses both.
    await page.goto("/debts");
    await page.getByRole("button", { name: /visa platinum/i }).click();
    await page.getByRole("button", { name: /remove payment of \$150\.00/i }).click();
    await expect(page.getByText("No payments yet.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card).toContainText("$2,000.00 remaining");
    await expect(await accountRow(page, "Main Checking")).toContainText("$0.00");
    await expect(await accountRow(page, "Visa Liability")).toContainText("$2,000.00");
  });

  test("edits, archives, restores and deletes a debt", async ({ page }) => {
    // Long flow across several pages.
    test.slow();
    await registerAndCompleteOnboarding(page);
    await page.goto("/debts");
    await page.getByRole("button", { name: /add debt/i }).click();
    await page.getByLabel("Current balance").fill("50000");
    await page.getByLabel("Original amount").fill("100000");
    await page.getByLabel("Debt name").fill("Car loan");
    await page.getByRole("combobox", { name: "Debt type" }).click();
    await page.getByRole("option", { name: "Loan", exact: true }).click();
    await page.getByRole("button", { name: /create debt/i }).click();
    await expect(page.getByRole("button", { name: /car loan/i })).toContainText("50%");

    // A current balance above the original amount is refused inside the dialog.
    await page.getByRole("button", { name: /car loan/i }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Edit" }).click();
    await expect(page.getByLabel("Debt name")).toHaveValue("Car loan");
    await page.getByLabel("Current balance").fill("200000");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(/cannot exceed/i);
    await page.getByLabel("Current balance").fill("25000");
    await page.getByLabel("Debt name").fill("Car loan (Toyota)");
    await page.getByRole("button", { name: "Save changes" }).click();
    const card = page.getByRole("button", { name: /car loan \(toyota\)/i });
    await expect(card).toContainText("75%");

    await card.click();
    await page.getByRole("dialog").getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText("Car loan (Toyota)")).toHaveCount(0);
    await page.getByRole("button", { name: "Archived", exact: true }).click();
    await expect(card).toContainText("Archived");
    await card.click();
    await page.getByRole("dialog").getByRole("button", { name: "Restore" }).click();
    await expect(card).not.toContainText("Archived");

    await card.click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Yes, delete" }).click();
    await expect(page.getByText("No debts yet")).toBeVisible();
  });
});
