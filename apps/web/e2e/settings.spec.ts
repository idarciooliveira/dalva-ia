import { expect, test } from "@playwright/test";

import { registerAndCompleteOnboarding } from "./helpers/auth";
import { E2E_BOT_USERNAME, serviceCall } from "./helpers/stack";

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

    const command = page.getByTestId("telegram-start-command");
    await expect(command).toHaveText(/^\/start [A-Za-z0-9_-]{43}$/);
    const code = (await command.textContent())!.replace("/start ", "");
    // The bot username comes from the API (TELEGRAM_BOT_USERNAME), not a build variable.
    await expect(page.getByRole("link", { name: /open telegram/i })).toHaveAttribute(
      "href",
      `https://t.me/${E2E_BOT_USERNAME}?start=${code}`,
    );
    await expect(page.getByText(`@${E2E_BOT_USERNAME}`)).toBeVisible();
    await expect(page.getByText(/expires in (10:00|9:\d\d)/i)).toBeVisible();
  });

  test("links through the bot route, toggles read-only, deletes history and unlinks", async ({ page }) => {
    // Long flow across several pages.
    test.slow();
    await registerAndCompleteOnboarding(page);
    await page.goto("/settings");
    await page.getByLabel(/I understand and agree/i).check();
    await page.getByRole("button", { name: "Connect Telegram" }).click();
    const command = await page.getByTestId("telegram-start-command").textContent();
    const code = command!.replace("/start ", "");

    const externalUserId = String(Date.now());
    const chat = { channel: "telegram", externalUserId, chatId: externalUserId };
    const redeemed = await serviceCall("/channel-links/redeem", { ...chat, code, username: "e2e_user" });
    expect(redeemed.status).toBe(200);

    // The page polls while the code is pending and switches to the linked view without a reload.
    await expect(page.getByText("Connected as @e2e_user")).toBeVisible({ timeout: 15_000 });
    expect((await serviceCall("/channel-identities/resolve", chat)).status).toBe(200);

    const readOnly = page.getByRole("switch", { name: "Read-only" });
    await expect(readOnly).not.toBeChecked();
    await readOnly.click();
    await expect(readOnly).toBeChecked();
    // Stored, not just toggled in the page.
    await page.reload();
    await expect(page.getByRole("switch", { name: "Read-only" })).toBeChecked();

    // Delete chat history: asks first, cancelling does nothing, confirming says so.
    await page.getByRole("button", { name: "Delete chat history" }).click();
    await expect(page.getByRole("alertdialog")).toContainText(/the bot forgets your past conversations/i);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("alertdialog")).toBeHidden();
    await expect(page.getByText("Chat history deleted.")).toBeHidden();
    await page.getByRole("button", { name: "Delete chat history" }).click();
    await page.getByRole("button", { name: "Delete history" }).click();
    await expect(page.getByText("Chat history deleted.")).toBeVisible();

    await page.getByRole("button", { name: "Unlink Telegram" }).click();
    await expect(page.getByRole("alertdialog")).toContainText(/loses access to your finances right away/i);
    await page.getByRole("button", { name: /^unlink$/i }).click();

    await expect(page.getByRole("button", { name: "Connect Telegram" })).toBeVisible();
    expect((await serviceCall("/channel-identities/resolve", chat)).status).toBe(404);
  });
});
