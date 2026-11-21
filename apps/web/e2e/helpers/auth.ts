import { expect, type Page } from "@playwright/test";

export interface TestUser {
  name: string;
  email: string;
  password: string;
}

export function newUser(name = "Debt Test User"): TestUser {
  return {
    name,
    email: `dalva-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    password: "password123",
  };
}

/** Signs up through the form; the app signs the new user in and opens onboarding. */
export async function register(page: Page, user: TestUser = newUser()): Promise<TestUser> {
  await page.goto("/register");
  await page.getByLabel("Name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.locator("#password").fill(user.password);
  await page.getByRole("button", { name: /create account/i }).click();

  await expect(page).toHaveURL(/\/onboarding/, { timeout: 20_000 });
  return user;
}

export async function logIn(page: Page, user: TestUser) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.locator("#password").fill(user.password);
  await page.getByRole("button", { name: /log in/i }).click();
}

/** Default onboarding: USD, one "Main Checking" account at 0, every default category. */
export async function registerAndCompleteOnboarding(page: Page, user: TestUser = newUser()): Promise<TestUser> {
  await register(page, user);

  await page.getByRole("button", { name: /^continue$/i }).click();

  await page.getByLabel(/account name/i).fill("Main Checking");
  await page.getByRole("button", { name: /^continue$/i }).click();

  await page.getByRole("button", { name: /get started/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  return user;
}
