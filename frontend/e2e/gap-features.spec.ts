import { expect, test, type Page } from "@playwright/test";

import { bff, createOrg, signUpViaApi, uniqueEmail } from "./helpers";

async function ownerWithOrg(page: Page, name: string) {
  await signUpViaApi(page, uniqueEmail("e2e-gap"), "Gap Tester");
  return createOrg(page, `${name} ${Date.now()}`);
}

test("merge duplicate works from the catalog overview", async ({ page }) => {
  const org = await ownerWithOrg(page, "Merge Org");
  const o = `/organizations/${org.id}`;
  const keep = await bff<{ id: string }>(page, "POST", `${o}/works`, { title: "Golden Hour", internal_code: "GH-1" });
  const dupe = await bff<{ id: string }>(page, "POST", `${o}/works?allow_duplicate=true`, { title: "Golden Hour", iswc: "T-034.524.680-1" });

  await page.goto("/catalog");
  await expect(page.getByText("Duplicate candidates")).toBeVisible();
  await page.getByRole("button", { name: /merge…/i }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Merge duplicate work")).toBeVisible();
  // Keep the first one; the merge button stays disabled until confirmed.
  await dialog.getByRole("radio").first().check();
  const submit = dialog.getByRole("button", { name: /merge into/i });
  await expect(submit).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "Confirm merge" }).click();
  await submit.click();
  await expect(page.getByText(/merged into/i).first()).toBeVisible();

  const [a, b] = await Promise.all([
    bff<{ status: string; iswc: string | null }>(page, "GET", `${o}/works/${keep.id}`),
    bff<{ status: string; iswc: string | null }>(page, "GET", `${o}/works/${dupe.id}`),
  ]);
  const archived = [a, b].filter((w) => w.status === "archived");
  expect(archived).toHaveLength(1);
  // The survivor carries the ISWC either way.
  expect([a, b].find((w) => w.status !== "archived")?.iswc).toBe("T0345246801");
});

test("edit a statement's details and external identifiers on a work", async ({ page }) => {
  const org = await ownerWithOrg(page, "Edit Org");
  const o = `/organizations/${org.id}`;
  const statement = await bff<{ id: string }>(page, "POST", `${o}/royalties/statements/manual`, {
    source_name: "Sync Desk", source_category: "licensing", period_start: "2026-02-01", period_end: "2026-02-28",
    currency: "USD", lines: [{ title: "Cue 1", amount: "100.00" }],
  });
  await page.goto(`/royalties/statements/${statement.id}`);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: /edit details/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Source name").fill("Sync Desk Europe");
  await dialog.getByLabel("Reported total").fill("100");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Statement updated")).toBeVisible();
  const saved = await bff<{ source_name: string; reported_total: string }>(page, "GET", `${o}/royalties/statements/${statement.id}`);
  expect(saved.source_name).toBe("Sync Desk Europe");
  expect(saved.reported_total).toBe("100.00000000");

  const work = await bff<{ id: string }>(page, "POST", `${o}/works`, { title: "Identifier Song" });
  await page.goto(`/catalog/works/${work.id}/edit`);
  await page.getByRole("button", { name: "Add identifier" }).click();
  await page.getByLabel("Identifier 1 name").fill("mlc_song_code");
  await page.getByLabel("Identifier 1 value").fill("M12345");
  await page.getByRole("button", { name: /save changes/i }).click();
  await expect(page).toHaveURL(new RegExp(`/catalog/works/${work.id}$`));
  const updated = await bff<{ external_ids: Record<string, string> | null }>(page, "GET", `${o}/works/${work.id}`);
  expect(updated.external_ids).toEqual({ mlc_song_code: "M12345" });
});

test("notification email preferences and invitation re-send", async ({ page }) => {
  const org = await ownerWithOrg(page, "Prefs Org");

  await page.goto("/settings/profile");
  const master = page.getByRole("switch", { name: "Email me about notifications" });
  await expect(master).toBeChecked();
  await page.getByRole("switch", { name: "Email: Completed imports" }).click();
  await expect(page.getByText("Email preferences saved").first()).toBeVisible();
  const prefs = await bff<{ types: { type: string; email: boolean }[] }>(page, "GET", "/auth/me/notification-preferences");
  expect(prefs.types.find((t) => t.type === "import_completed")?.email).toBe(true);

  await bff(page, "POST", `/organizations/${org.id}/invitations`, { email: uniqueEmail("e2e-invitee"), role: "viewer" });
  await page.goto("/settings/team?tab=invitations");
  await page.getByRole("tab", { name: /invitations/i }).click();
  await page.getByRole("button", { name: /actions|more/i }).last().click();
  await page.getByRole("menuitem", { name: /re-send with a new link/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("New invitation link")).toBeVisible();
  await expect(dialog.getByLabel("Invitation link")).toHaveValue(/\/invitations\/accept\?token=/);
});
