import { expect, test, type Page } from "@playwright/test";

import { registerAndCompleteOnboarding } from "./helpers/auth";

test.describe("Categories page - unauthenticated", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/categories");

    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  });
});

async function openCategories(page: Page) {
  await registerAndCompleteOnboarding(page);
  await page.getByRole("link", { name: "Categories" }).click();
  await expect(page).toHaveURL(/\/categories/);
  await expect(page.getByRole("heading", { name: "Categories" })).toBeVisible();
}

async function action(page: Page, name: string, item: string) {
  await page.getByRole("button", { name: `Open ${name} actions` }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test.describe("Categories page - category CRUD (apps/api)", () => {
  test("creates, edits, archives, restores and deletes a category", async ({ page }) => {
    await openCategories(page);

    await page.getByRole("button", { name: "Add expense category" }).click();
    await expect(page.getByRole("heading", { name: "New expense category" })).toBeVisible();
    await page.getByLabel("Category name").fill("Pets");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("heading", { name: "New expense category" })).toBeHidden();
    await expect(page.getByText("Pets", { exact: true })).toBeVisible();

    await action(page, "Pets", "Edit");
    await expect(page.getByRole("heading", { name: "Edit category" })).toBeVisible();
    await page.getByLabel("Category name").fill("Pets & Vet");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Pets & Vet", { exact: true })).toBeVisible();
    await expect(page.getByText("Pets", { exact: true })).toHaveCount(0);

    await action(page, "Pets & Vet", "Archive");
    await expect(page.getByText("Pets & Vet", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /^archived/i }).click();
    await expect(page.getByText("Pets & Vet", { exact: true })).toBeVisible();
    await action(page, "Pets & Vet", "Restore");
    await page.getByRole("button", { name: /^archived/i }).click();
    await expect(page.getByText("Pets & Vet", { exact: true })).toBeVisible();

    await action(page, "Pets & Vet", "Delete");
    await page.getByRole("button", { name: "Yes, delete" }).click();
    await expect(page.getByText("Pets & Vet", { exact: true })).toHaveCount(0);

    // Still gone after a reload: the delete reached the API.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Categories" })).toBeVisible();
    await expect(page.getByText("Food & Dining", { exact: true })).toBeVisible();
    await expect(page.getByText("Pets & Vet", { exact: true })).toHaveCount(0);
  });
});

test.describe("Categories page - subcategories (apps/api)", () => {
  test("creates, renames, archives and deletes a subcategory", async ({ page }) => {
    await openCategories(page);

    await page
      .getByRole("button", { name: "Expand Food & Dining subcategories" })
      .click();
    await action(page, "Food & Dining", "Add subcategory");

    await expect(
      page.getByRole("heading", { name: "Add subcategory" }),
    ).toBeVisible();
    await page.getByLabel("Subcategory name").fill("Groceries");
    await page.getByRole("button", { name: "Add subcategory" }).click();

    await expect(page.getByText("Groceries", { exact: true })).toBeVisible();

    await action(page, "Groceries", "Edit");
    await expect(
      page.getByRole("heading", { name: "Edit subcategory" }),
    ).toBeVisible();
    await page.getByLabel("Subcategory name").fill("Weekly groceries");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("Weekly groceries", { exact: true })).toBeVisible();
    await expect(page.getByText("Groceries", { exact: true })).toHaveCount(0);

    await action(page, "Weekly groceries", "Archive");
    await expect(page.getByText("Weekly groceries", { exact: true })).toHaveCount(0);
    // The row stays expanded while the list refetches with archived items.
    await page.getByRole("button", { name: /^archived/i }).click();
    await expect(page.getByText("Weekly groceries", { exact: true })).toBeVisible();

    await action(page, "Weekly groceries", "Delete");
    await page.getByRole("button", { name: "Yes, delete" }).click();
    await expect(page.getByText("Weekly groceries", { exact: true })).toHaveCount(0);
  });
});
