import { expect, type Page } from "@playwright/test";

/** To the accounts page, unless already there (its list is refreshed by every write made on it). */
async function gotoAccounts(page: Page) {
  if (new URL(page.url()).pathname !== "/accounts") await page.goto("/accounts");
}

/**
 * Creates an account through the accounts page. `balanceMinor` is typed into the
 * masked input, so it is in minor units ("-200000" is -2,000.00 in USD).
 */
export async function createAccount(
  page: Page,
  account: { name: string; type?: RegExp; currency?: RegExp; balanceMinor?: string },
) {
  await gotoAccounts(page);
  await page.getByRole("button", { name: /add account/i }).click();
  await expect(page.getByRole("heading", { name: "New account" })).toBeVisible();
  if (account.currency) {
    await page.getByLabel("Currency").click();
    await page.getByRole("option", { name: account.currency }).click();
  }
  if (account.balanceMinor) await page.getByLabel("Opening balance").fill(account.balanceMinor);
  await page.getByLabel("Account name").fill(account.name);
  if (account.type) {
    await page.getByLabel("Account type").click();
    await page.getByRole("option", { name: account.type }).click();
  }
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "New account" })).toBeHidden();
  await expect(page.getByRole("listitem", { name: account.name, exact: true })).toBeVisible();
}

/** The account's row on the accounts page. */
export async function accountRow(page: Page, name: string) {
  await gotoAccounts(page);
  return page.getByRole("listitem", { name, exact: true });
}
