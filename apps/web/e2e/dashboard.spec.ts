import { expect, test } from "@playwright/test";

import { accountId, apiWrite, createAccount, today, usd } from "./helpers/api";
import { registerAndCompleteOnboarding } from "./helpers/auth";

test.describe("Dashboard (apps/api)", () => {
  test("shows empty states for a new user", async ({ page }) => {
    await registerAndCompleteOnboarding(page);

    await expect(page.getByText("Your latest transactions will appear here once you add a record.")).toBeVisible();
    await expect(page.getByText("No expenses recorded this month.")).toBeVisible();
    await expect(page.getByText("No cashflow data yet.")).toBeVisible();
    await expect(page.getByText("Your savings goals will appear here once you create one.")).toBeVisible();
    await expect(page.getByText("No debts tracked yet.")).toBeVisible();
  });

  test("accounts in another currency: recent rows stay, reports say why they're missing", async ({ page }) => {
    await registerAndCompleteOnboarding(page);
    const { account } = await apiWrite<{ account: { id: string } }>(page, "POST", "/accounts", {
      name: "Euro Account",
      type: "bank",
      balance: { amountMinor: 0, currency: "EUR" },
    });
    await apiWrite(page, "POST", "/transactions", {
      type: "expense",
      amount: { amountMinor: 1_999, currency: "EUR" },
      accountId: account.id,
      date: today(),
      description: "Paris lunch",
    });

    await page.goto("/dashboard");
    await expect(page.getByText("Paris lunch")).toBeVisible();
    await expect(page.getByText("-€19.99")).toBeVisible();
    await expect(page.getByText("Reports across multiple currencies are not supported yet").first()).toBeVisible();
    await expect(page.getByRole("group", { name: "Total income" })).toContainText("—");
  });

  test("reflects transactions, goals and debts, and updates after a quick-action write", async ({ page }) => {
    await registerAndCompleteOnboarding(page);
    const main = await accountId(page, "Main Checking");
    await apiWrite(page, "POST", "/transactions", { type: "income", amount: usd(300_000), accountId: main, date: today(), description: "Paycheck" });
    const savings = await createAccount(page, "Savings");
    await apiWrite(page, "POST", "/goals", { name: "Holiday", targetAmount: usd(200_000), isVirtual: false, linkedAccountId: savings });
    await apiWrite(page, "POST", "/debts", { name: "Car loan", debtType: "loan", lender: "Bank", originalAmount: usd(1_000_000), currentBalance: usd(750_000) });

    await page.goto("/dashboard");
    const income = page.getByRole("group", { name: "Total income" });
    await expect(income).toContainText("$3,000.00");
    await expect(page.getByText("Paycheck")).toBeVisible();
    await expect(page.getByText("Holiday")).toBeVisible();
    await expect(page.getByText("Car loan")).toBeVisible();
    await expect(page.getByText("25% paid off")).toBeVisible();

    // A quick-action expense updates the totals, spending and recent rows in place.
    await page.getByRole("button", { name: "Register expense" }).click();
    await page.getByLabel("Amount").fill("4250");
    await page.getByLabel("Description").fill("Dinner out");
    await page.getByRole("combobox", { name: "Category" }).click();
    await page.getByRole("option", { name: "Food & Dining" }).click();
    await page.getByRole("combobox", { name: "Account", exact: true }).click();
    await page.getByRole("option", { name: "Main Checking" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const expenses = page.getByRole("group", { name: "Total expenses" });
    await expect(expenses).toContainText("$42.50");
    await expect(page.getByText("Dinner out")).toBeVisible();
    const spending = page.locator('[data-slot="card"]', { hasText: "Spending by Category" });
    await expect(spending).toContainText("Food & Dining");
    await expect(spending).toContainText("$42.50");
    // Net worth: 3,000.00 - 42.50 in accounts, minus the 7,500.00 debt.
    await expect(page.getByText("-$4,542.50")).toBeVisible();
  });
});
