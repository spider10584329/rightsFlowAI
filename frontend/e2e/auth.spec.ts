import { expect, test } from "@playwright/test";

import { PASSWORD, uniqueEmail } from "./helpers";

test("protected routes redirect to login with a return path", async ({ page }) => {
  await page.goto("/royalties/statements");
  await expect(page).toHaveURL(/\/login\?next=%2Froyalties%2Fstatements/);
});

test("register, onboard an organization, sign out and sign back in", async ({ page }) => {
  const email = uniqueEmail("e2e-auth");

  await page.goto("/register");
  await page.getByLabel("Full name").fill("Avery Example");
  await page.getByLabel("Work email").fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();

  // New users without an organization land on onboarding.
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel("Organization name").fill(`E2E Publishing ${Date.now()}`);
  await page.getByRole("button", { name: /create organization/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // Session cookies are httpOnly: page JavaScript can't read tokens.
  const visible = await page.evaluate(() => document.cookie);
  expect(visible).not.toContain("rf_at");
  expect(visible).not.toContain("rf_rt");

  // Sign out via the user menu.
  await page.getByRole("button", { name: /account menu for avery/i }).click();
  await page.getByRole("menuitem", { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);

  // Signing back in honours the `next` parameter.
  await page.goto("/login?next=%2Fcatalog%2Fworks");
  await page.getByLabel("Email address").fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/catalog\/works/);
});

test("wrong password shows a generic error", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(uniqueEmail("nobody"));
  await page.locator('input[type="password"]').fill("not-the-password");
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page.getByText(/invalid email or password/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});
