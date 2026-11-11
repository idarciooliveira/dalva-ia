import { expect, test } from "@playwright/test";

import { registerAndCompleteOnboarding } from "./helpers/auth";

/**
 * The unlink test links a chat through the service route, like the bot would.
 * It needs the Convex site URL and the deployment's service key:
 *   E2E_CONVEX_SITE_URL=http://127.0.0.1:3211 E2E_FINANCE_API_SERVICE_KEY=... bun run test:e2e
 */
const siteUrl = process.env.E2E_CONVEX_SITE_URL;
const serviceKey = process.env.E2E_FINANCE_API_SERVICE_KEY;

async function service(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${siteUrl}/api/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { ok: boolean } };
}

test.describe("Settings → Telegram", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  });

  test("requires consent, then shows a deep link, countdown and /start fallback", async ({ page }) => {
    await registerAndCompleteOnboarding(page);
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings/);

    await expect(page.getByText(/processed by Telegram and by an AI provider/i)).toBeVisible();
    const connect = page.getByRole("button", { name: "Connect Telegram" });
    await expect(connect).toBeDisabled();

    await page.getByLabel(/I understand and agree/i).check();
    await connect.click();

    const deepLink = page.getByRole("link", { name: /open telegram/i });
    await expect(deepLink).toHaveAttribute("href", /^https:\/\/t\.me\/dalva_test_bot\?start=[A-Za-z0-9_-]{43}$/);
    const href = (await deepLink.getAttribute("href"))!;
    const code = new URL(href).searchParams.get("start");
    await expect(page.getByTestId("telegram-start-command")).toHaveText(`/start ${code}`);
    await expect(page.getByText(/expires in (10:00|9:\d\d)/i)).toBeVisible();
  });

  test("links through the bot route, toggles read-only and unlinks", async ({ page }) => {
    test.skip(!siteUrl || !serviceKey, "E2E_CONVEX_SITE_URL and E2E_FINANCE_API_SERVICE_KEY are required");
    await registerAndCompleteOnboarding(page);
    await page.goto("/settings");
    await page.getByLabel(/I understand and agree/i).check();
    await page.getByRole("button", { name: "Connect Telegram" }).click();
    const command = await page.getByTestId("telegram-start-command").textContent();
    const code = command!.replace("/start ", "");

    const externalUserId = String(Date.now());
    const chat = { channel: "telegram", externalUserId, chatId: externalUserId };
    const redeemed = await service("/channel-links/redeem", { ...chat, code, username: "e2e_user" });
    expect(redeemed.status).toBe(200);

    // Live update: the page switches to the linked view without a reload.
    await expect(page.getByText("Connected as @e2e_user")).toBeVisible({ timeout: 15_000 });
    expect((await service("/channel-identities/resolve", chat)).status).toBe(200);

    const readOnly = page.getByRole("switch", { name: "Read-only" });
    await expect(readOnly).not.toBeChecked();
    await readOnly.click();
    await expect(readOnly).toBeChecked();

    await page.getByRole("button", { name: "Unlink Telegram" }).click();
    await expect(page.getByRole("alertdialog")).toContainText(/loses access to your finances right away/i);
    await page.getByRole("button", { name: /^unlink$/i }).click();

    await expect(page.getByRole("button", { name: "Connect Telegram" })).toBeVisible();
    expect((await service("/channel-identities/resolve", chat)).status).toBe(404);
  });
});
