import { test, expect } from "@playwright/test";

import { logIn, newUser, register, registerAndCompleteOnboarding } from "./helpers/auth";

test.describe("Login page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
  });

  test("renders login form with all fields", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: /welcome back/i })
    ).toBeVisible();

    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.getByRole("button", { name: /log in/i })).toBeVisible();
  });

  test("shows validation errors for empty form submission", async ({
    page,
  }) => {
    // Submit the form empty
    await page.getByRole("button", { name: /log in/i }).click();

    // Validation errors should appear (wait for react-hook-form + zod async validation)
    await expect(
      page.getByText(/please enter a valid email/i)
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/password must be at least 8 characters/i)
    ).toBeVisible();
  });

  test("shows validation error for invalid email", async ({ page }) => {
    await page.getByLabel("Email").fill("not-an-email");
    await page.locator("#password").fill("12345678");
    await page.getByRole("button", { name: /log in/i }).click();

    await expect(page.getByText(/please enter a valid email/i)).toBeVisible();
  });

  test("shows validation error for short password", async ({ page }) => {
    await page.getByLabel("Email").fill("test@example.com");
    await page.locator("#password").fill("short");
    await page.getByRole("button", { name: /log in/i }).click();

    await expect(
      page.getByText(/password must be at least 8 characters/i)
    ).toBeVisible();
  });

  test("has link to register page", async ({ page }) => {
    const signUpLink = page.getByRole("link", { name: /sign up/i });
    await expect(signUpLink).toBeVisible();
    await signUpLink.click();
    await expect(page).toHaveURL(/\/register/);
  });

  test("has link to forgot password page", async ({ page }) => {
    const forgotLink = page.getByRole("link", { name: /forgot password/i });
    await expect(forgotLink).toBeVisible();
    await forgotLink.click();
    await expect(page).toHaveURL(/\/forgot-password/);
  });

  test("has Google OAuth button", async ({ page }) => {
    await expect(
      page.getByRole("button", { name: /google/i })
    ).toBeVisible();
  });
});

test.describe("Register page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/register");
  });

  test("renders register form with all fields", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: /create your account/i })
    ).toBeVisible();

    await expect(page.getByLabel("Name")).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /create account/i })
    ).toBeVisible();
  });

  test("shows validation errors for empty form submission", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /create account/i }).click();

    await expect(page.getByText(/please enter your name/i)).toBeVisible();
    await expect(page.getByText(/please enter a valid email/i)).toBeVisible();
    await expect(
      page.getByText(/password must be at least 8 characters/i)
    ).toBeVisible();
  });

  test("has link to login page", async ({ page }) => {
    const loginLink = page.getByRole("link", { name: /log in/i });
    await expect(loginLink).toBeVisible();
    await loginLink.click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("shows terms and privacy policy links", async ({ page }) => {
    await expect(page.getByText(/terms of service/i)).toBeVisible();
    await expect(page.getByText(/privacy policy/i)).toBeVisible();
  });

  test("has Google OAuth button", async ({ page }) => {
    await expect(
      page.getByRole("button", { name: /google/i })
    ).toBeVisible();
  });
});

test.describe("Auth flows (apps/api)", () => {
  test("register, sign out, then log back in", async ({ page }) => {
    const user = await registerAndCompleteOnboarding(page, newUser("Flow Tester"));
    // The shell renders the greeting from the session and profile (dashboard data stays on Convex until PR 10).
    await expect(page.getByRole("heading", { name: /, Flow$/ })).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();

    await page.goto("/accounts");
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });

    await logIn(page, user);
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /, Flow$/ })).toBeVisible();
  });

  test("a wrong password shows an error and stays on /login", async ({ page }) => {
    const user = await registerAndCompleteOnboarding(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/$/);

    await logIn(page, { ...user, password: "wrong-password" });
    await expect(page.getByRole("alert")).toContainText("Invalid email or password");
    await expect(page).toHaveURL(/\/login/);
  });

  test("an email already registered shows an error", async ({ page, browser }) => {
    const user = await register(page);

    const other = await browser.newPage();
    await other.goto("/register");
    await other.getByLabel("Name").fill("Someone Else");
    await other.getByLabel("Email").fill(user.email);
    await other.locator("#password").fill("password456");
    await other.getByRole("button", { name: /create account/i }).click();
    await expect(other.getByRole("alert")).toContainText("already exists");
    await expect(other).toHaveURL(/\/register/);
    await other.close();
  });

  test("logging in before onboarding is done resumes onboarding", async ({ page, browser }) => {
    const user = await register(page);

    const other = await browser.newPage();
    await logIn(other, user);
    await expect(other).toHaveURL(/\/onboarding/, { timeout: 20_000 });
    await other.close();
  });
});
