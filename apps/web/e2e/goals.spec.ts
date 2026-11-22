import { test, expect } from "@playwright/test";

import { accountRow, createAccount } from "./helpers/accounts";
import { registerAndCompleteOnboarding } from "./helpers/auth";

test.describe("Goals page — unauthenticated", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    const response = await page.goto("/goals");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  });
});

test.describe("Goals page (apps/api)", () => {
  test("a virtual goal: create, contribute, remove, edit, archive, restore, delete", async ({ page }) => {
    // Long flow across several pages.
    test.slow();
    await registerAndCompleteOnboarding(page);
    await page.getByRole("link", { name: "Goals" }).click();
    await expect(page.getByRole("heading", { name: "Savings Goals" })).toBeVisible();
    await expect(page.getByText("No savings goals yet")).toBeVisible();

    await page.getByRole("button", { name: "Add goal" }).click();
    await page.getByLabel("Target amount").fill("100000");
    await page.getByLabel("Goal name").fill("Vacation");
    await page.getByLabel("Target date").fill("2027-06-01");
    await page.getByRole("button", { name: "Create goal" }).click();
    await expect(page.getByRole("heading", { name: "New savings goal" })).toBeHidden();

    const card = page.getByRole("button", { name: /vacation/i });
    await expect(card).toContainText("0%");
    await expect(card).toContainText("Due Jun 2027");
    await expect(card).toContainText("$1,000.00 target");

    // Virtual goals take no account.
    await card.click();
    await page.getByRole("button", { name: "Contribute" }).click();
    await expect(page.getByRole("heading", { name: "Add contribution" })).toBeVisible();
    await expect(page.getByLabel("Source account")).toHaveCount(0);
    await page.getByLabel("Contribution amount").fill("25000");
    await page.getByLabel("Note").fill("First deposit");
    await page.getByRole("button", { name: "Add contribution" }).click();
    await expect(page.getByRole("heading", { name: "Add contribution" })).toBeHidden();
    await expect(card).toContainText("25%");
    await expect(card).toContainText("$250.00 saved");

    await card.click();
    const contributions = page.getByRole("list", { name: "Contributions" });
    await expect(contributions).toContainText("$250.00");
    await expect(contributions).toContainText("First deposit");
    await expect(page.getByRole("dialog")).toContainText("$750.00 to go");
    await page.getByRole("button", { name: /remove contribution of \$250\.00/i }).click();
    await expect(page.getByText("No contributions yet.")).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("$1,000.00 to go");

    await page.getByRole("dialog").getByRole("button", { name: "Edit" }).click();
    await expect(page.getByLabel("Goal name")).toHaveValue("Vacation");
    await page.getByLabel("Goal name").fill("Summer trip");
    await page.getByLabel("Target amount").fill("200000");
    // The API can't clear the date: refused in the dialog instead of silently kept.
    await page.getByLabel("Target date").fill("");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("can be changed but not removed");
    await page.getByLabel("Target date").fill("2027-08-01");
    await page.getByRole("button", { name: "Save changes" }).click();
    const renamed = page.getByRole("button", { name: /summer trip/i });
    await expect(renamed).toContainText("$2,000.00 target");
    await expect(renamed).toContainText("Due Aug 2027");

    // Archive hides it; the Archived toggle shows it again; restore.
    await renamed.click();
    await page.getByRole("button", { name: "Archive goal" }).click();
    await expect(page.getByText("Summer trip")).toHaveCount(0);
    await page.getByRole("button", { name: "Archived", exact: true }).click();
    await expect(renamed).toContainText("Archived");
    await renamed.click();
    await expect(page.getByRole("button", { name: "Contribute" })).toHaveCount(0);
    await page.getByRole("button", { name: "Restore goal" }).click();
    await expect(renamed).not.toContainText("Archived");

    // Delete asks first.
    await renamed.click();
    await page.getByRole("button", { name: "Delete goal" }).click();
    await page.getByRole("button", { name: "No" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Delete goal" }).click();
    await page.getByRole("button", { name: "Yes, delete" }).click();
    await expect(page.getByText("No savings goals yet")).toBeVisible();
  });

  test("an account-linked goal moves money between base-currency accounts", async ({ page }) => {
    // Long flow across several pages.
    test.slow();
    await registerAndCompleteOnboarding(page);
    await createAccount(page, { name: "Rainy Day", type: /savings/i });
    // Not in the base currency (USD): the pickers leave it out.
    await createAccount(page, { name: "Euro Savings", type: /savings/i, currency: /EUR — Euro/ });

    await page.goto("/goals");
    await page.getByRole("button", { name: "Add goal" }).click();
    await page.getByLabel("Target amount").fill("50000");
    await page.getByLabel("Goal name").fill("Emergency fund");
    await page.getByRole("combobox", { name: "Tracking mode" }).click();
    await page.getByRole("option", { name: "Link to account" }).click();
    await page.getByRole("combobox", { name: "Linked account" }).click();
    await expect(page.getByRole("option", { name: "Rainy Day" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Euro Savings" })).toHaveCount(0);
    await page.getByRole("option", { name: "Rainy Day" }).click();
    await expect(page.getByText(/only accounts in USD/i)).toBeVisible();
    await page.getByRole("button", { name: "Create goal" }).click();
    await expect(page.getByRole("heading", { name: "New savings goal" })).toBeHidden();

    const card = page.getByRole("button", { name: /emergency fund/i });
    await card.click();
    await page.getByRole("button", { name: "Contribute" }).click();
    await page.getByLabel("Contribution amount").fill("5000");
    // A source account is required, and never the linked account itself.
    await page.getByRole("button", { name: "Add contribution" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("select a source account");
    await page.getByRole("combobox", { name: "Source account" }).click();
    await expect(page.getByRole("option", { name: "Main Checking" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Rainy Day" })).toHaveCount(0);
    await expect(page.getByRole("option", { name: "Euro Savings" })).toHaveCount(0);
    await page.getByRole("option", { name: "Main Checking" }).click();
    await page.getByRole("button", { name: "Add contribution" }).click();
    await expect(page.getByRole("heading", { name: "Add contribution" })).toBeHidden();
    await expect(card).toContainText("10%");

    // The contribution is a transfer: Main Checking -50, Rainy Day +50.
    await expect(await accountRow(page, "Main Checking")).toContainText("$50.00");
    await expect(await accountRow(page, "Main Checking")).toContainText("owing");
    await expect(await accountRow(page, "Rainy Day")).toContainText("$50.00");

    // Removing it reverses the transfer.
    await page.goto("/goals");
    await page.getByRole("button", { name: /emergency fund/i }).click();
    await page.getByRole("button", { name: /remove contribution of \$50\.00/i }).click();
    await expect(page.getByText("No contributions yet.")).toBeVisible();
    await expect(await accountRow(page, "Main Checking")).toContainText("$0.00");
    await expect(await accountRow(page, "Rainy Day")).toContainText("$0.00");
  });
});
