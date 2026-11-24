import { expect, test, type Page } from "@playwright/test";

import { accountId, accountRow, apiWrite, createAccount, usd } from "./helpers/api";
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

/** Fills the open income/expense dialog. Amount digits shift in from the right ("2000" is 20,00). */
async function fillTransaction(
  page: Page,
  { amount, description, category, account = "Main Checking" }: { amount: string; description: string; category?: string; account?: string },
) {
  await page.getByLabel("Amount").fill(amount);
  await page.getByLabel("Description").fill(description);
  if (category) {
    await page.getByRole("combobox", { name: "Category" }).click();
    await page.getByRole("option", { name: category }).click();
  }
  await page.getByRole("combobox", { name: "Account", exact: true }).click();
  await page.getByRole("option", { name: account }).click();
}

async function openRowAction(page: Page, title: string, action: string | RegExp) {
  await page.getByRole("button", { name: `Open ${title} actions` }).click();
  await page.getByRole("menuitem", { name: action }).click();
}

test.describe("Transactions page - edit flow", () => {
  test("editing a transaction without changing the amount preserves its value", async ({ page }) => {
    await registerAndCompleteOnboarding(page);

    await page.goto("/transactions");
    await expect(page.getByRole("heading", { name: "Transactions" })).toBeVisible();

    await page.getByRole("button", { name: /add transaction/i }).click();
    await expect(page.getByRole("heading", { name: "New expense" })).toBeVisible();

    await fillTransaction(page, { amount: "2000", description: "Lunch" });
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.getByText("Lunch", { exact: true })).toBeVisible();

    await openRowAction(page, "Lunch", "Edit");
    await expect(page.getByRole("heading", { name: "Edit expense" })).toBeVisible();
    await expect(page.getByLabel("Amount")).toHaveValue("20,00");

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    await openRowAction(page, "Lunch", "Edit");
    await expect(page.getByLabel("Amount")).toHaveValue("20,00");
  });
});

test.describe("Transactions (apps/api)", () => {
  test("create, edit and delete move the account balance", async ({ page }) => {
    test.slow();
    await registerAndCompleteOnboarding(page);
    await page.goto("/transactions");
    await expect(page.getByText("No transactions yet")).toBeVisible();

    // Income, then an expense with "Save & new".
    await page.getByRole("button", { name: /add transaction/i }).click();
    await page.getByRole("button", { name: "Income", exact: true }).click();
    await expect(page.getByRole("heading", { name: "New income" })).toBeVisible();
    await fillTransaction(page, { amount: "100000", description: "Salary", category: "Salary" });
    await page.getByRole("button", { name: "Save & new" }).click();
    await expect(page.getByLabel("Amount")).toHaveValue("");
    await page.getByRole("button", { name: "Expense", exact: true }).click();
    await fillTransaction(page, { amount: "2550", description: "Groceries", category: "Food & Dining" });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const groceries = page.getByRole("listitem", { name: "Groceries" });
    await expect(groceries).toContainText("-$25.50");
    await expect(groceries).toContainText("Food & Dining · Main Checking");
    await expect(page.getByRole("listitem", { name: "Salary" })).toContainText("+$1,000.00");

    await page.goto("/accounts");
    await expect(accountRow(page, "Main Checking")).toContainText("$974.50");

    // Edit: amount and category.
    await page.goto("/transactions");
    await openRowAction(page, "Groceries", "Edit");
    await expect(page.getByLabel("Amount")).toHaveValue("25,50");
    await page.getByLabel("Amount").fill("4000");
    await page.getByRole("combobox", { name: "Category" }).click();
    await page.getByRole("option", { name: "Shopping" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(groceries).toContainText("-$40.00");
    await expect(groceries).toContainText("Shopping · Main Checking");

    await page.goto("/accounts");
    await expect(accountRow(page, "Main Checking")).toContainText("$960.00");

    // Clearing a field on edit clears it (the API takes null).
    await page.goto("/transactions");
    await openRowAction(page, "Salary", "Edit");
    await page.getByRole("button", { name: "More details" }).click();
    await page.getByLabel("Payee").fill("Acme Corp");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await openRowAction(page, "Salary", "Edit");
    await expect(page.getByLabel("Payee")).toHaveValue("Acme Corp");
    await page.getByLabel("Payee").fill("");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await openRowAction(page, "Salary", "Edit");
    // No payee or note left: the extra fields start collapsed again.
    await expect(page.getByRole("button", { name: "More details" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();

    // Delete restores the balance.
    await page.goto("/transactions");
    await openRowAction(page, "Groceries", "Delete");
    await page.getByRole("button", { name: "Yes, delete" }).click();
    await expect(groceries).not.toBeVisible();

    await page.goto("/accounts");
    await expect(accountRow(page, "Main Checking")).toContainText("$1,000.00");
  });

  test("validates the form and keeps the dialog open on errors", async ({ page }) => {
    await registerAndCompleteOnboarding(page);
    await page.goto("/transactions");

    await page.getByRole("button", { name: /add transaction/i }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("Please enter a valid amount greater than 0");
    await expect(page.getByLabel("Amount")).toHaveAttribute("aria-invalid", "true");

    await page.getByLabel("Amount").fill("500");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("Please select an account");
    await expect(page.getByRole("heading", { name: "New expense" })).toBeVisible();
  });

  test("searches, filters and pages through transactions", async ({ page }) => {
    test.slow();
    await registerAndCompleteOnboarding(page);
    const main = await accountId(page, "Main Checking");
    // 26 rows: one more than a page.
    for (let i = 1; i <= 25; i++) {
      await apiWrite(page, "transactions.create", {
        type: "expense",
        amount: usd(100 + i),
        accountId: main,
        date: `2026-01-${String(i).padStart(2, "0")}`,
        description: `Coffee ${i}`,
      });
    }
    await apiWrite(page, "transactions.create", {
      type: "income",
      amount: usd(5000),
      accountId: main,
      date: "2026-02-01",
      description: "Refund",
      payee: "Bookshop",
    });

    await page.goto("/transactions");
    const list = page.getByRole("list", { name: "Transactions" });
    await expect(list.getByRole("listitem")).toHaveCount(25, { timeout: 15_000 });
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(list.getByRole("listitem")).toHaveCount(26);
    await expect(page.getByRole("button", { name: "Load more" })).not.toBeVisible();

    // Search covers the payee.
    await page.getByLabel("Search transactions").fill("bookshop");
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list).toContainText("Refund");

    await page.getByLabel("Search transactions").fill("nothing like this");
    await expect(page.getByText("No matching transactions")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    // The unfiltered list comes back from the cache with both pages loaded.
    await expect(list.getByRole("listitem")).toHaveCount(26);

    // Type filter.
    await page.getByRole("button", { name: /^filters/i }).click();
    await page.getByRole("combobox", { name: "Type" }).click();
    await page.getByRole("option", { name: "Income" }).click();
    await page.keyboard.press("Escape");
    await expect(list.getByRole("listitem")).toHaveCount(1);

    // An inverted date range is caught before it reaches the API.
    await page.getByRole("button", { name: /^filters/i }).click();
    await page.getByLabel("From", { exact: true }).fill("2026-03-01");
    await page.getByLabel("To", { exact: true }).fill("2026-01-01");
    await expect(page.getByText("The start date is after the end date.").first()).toBeVisible();
  });

  test("rows owned by goals and debts can't be edited here", async ({ page }) => {
    await registerAndCompleteOnboarding(page);
    const main = await accountId(page, "Main Checking");
    const savings = await createAccount(page, "Savings");
    await apiWrite(page, "transactions.create", { type: "income", amount: usd(100_000), accountId: main, date: "2026-01-01", description: "Salary" });

    const { goal } = await apiWrite<{ goal: { id: string } }>(page, "goals.create", {
      name: "Trip",
      targetAmount: usd(50_000),
      isVirtual: false,
      linkedAccountId: savings,
    });
    await apiWrite(page, "goalContributions.add", {
      goalId: goal.id,
      amount: usd(10_000),
      date: "2026-01-02",
      note: "Trip savings",
      fromAccountId: main,
    });
    const { debt } = await apiWrite<{ debt: { id: string } }>(page, "debts.create", {
      name: "Car loan",
      debtType: "loan",
      originalAmount: usd(500_000),
      currentBalance: usd(400_000),
    });
    await apiWrite(page, "debtPayments.record", {
      debtId: debt.id,
      amount: usd(20_000),
      date: "2026-01-03",
      fromAccountId: main,
    });

    await page.goto("/transactions");
    const list = page.getByRole("list", { name: "Transactions" });
    // Salary, the contribution's two legs, the payment.
    await expect(list.getByRole("listitem")).toHaveCount(4);

    const rows = list.getByRole("listitem");
    const contributionLeg = rows.filter({ hasText: "Main Checking  →  Savings" });
    await contributionLeg.getByRole("button", { name: /actions$/ }).click();
    await expect(page.getByRole("menu")).toContainText("Part of a savings goal contribution");
    await expect(page.getByRole("menuitem", { name: /edit/i })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: /delete/i })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Manage in Goals" })).toBeVisible();
    await page.keyboard.press("Escape");

    const payment = rows.filter({ hasText: "-$200.00" });
    await payment.getByRole("button", { name: /actions$/ }).click();
    await expect(page.getByRole("menu")).toContainText("Part of a debt payment");
    await expect(page.getByRole("menuitem", { name: /delete/i })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Manage in Debts" }).click();
    await expect(page).toHaveURL(/\/debts/);
  });
});
