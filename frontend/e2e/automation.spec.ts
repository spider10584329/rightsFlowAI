import { expect, test } from "@playwright/test";

import { bff, createOrg, signUpViaApi, uniqueEmail } from "./helpers";

test("admin creates an automation key that is shown once, then sees it listed", async ({ page }) => {
  await signUpViaApi(page, uniqueEmail("e2e-automation"), "Automation Admin");
  const org = await createOrg(page, `Automation Org ${Date.now()}`);

  await page.goto("/settings/automation?tab=keys");
  await page.getByRole("tab", { name: /keys/i }).click();
  await page.getByRole("button", { name: "Create key" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Create automation key")).toBeVisible();
  await dialog.getByLabel("Name").fill("n8n e2e");
  await dialog.getByRole("button", { name: "Create key" }).click();

  // The full key is displayed exactly once, with the setup command.
  const keyField = dialog.getByLabel("Automation key");
  await expect(keyField).toBeVisible();
  const token = await keyField.inputValue();
  expect(token).toMatch(/^rfa_[0-9a-f]{16}_/);
  await expect(dialog.getByText("This key can't be shown again")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Listed by name and hint only; the secret never appears again.
  await expect(page.getByText("n8n e2e")).toBeVisible();
  await expect(page.getByText(token)).toHaveCount(0);

  // The key works against the automation API and is bound to this organization.
  const who = await page.request.get("http://127.0.0.1:8000/api/v1/automation/whoami", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(who.ok()).toBeTruthy();
  expect((await who.json()).organization_id).toBe(org.id);

  // Review queue renders (empty for a new organization).
  await page.getByRole("tab", { name: /review queue/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();

  const listed = await bff<{ name: string; state: string }[]>(page, "GET", `/organizations/${org.id}/automation/credentials`);
  expect(listed.map((c) => [c.name, c.state])).toEqual([["n8n e2e", "active"]]);
});
