import path from "node:path";

import { expect, test } from "@playwright/test";

import { bff, createOrg, signUpViaApi, uniqueEmail } from "./helpers";

const SAMPLE = path.resolve(__dirname, "../../docs/samples/sample-distributor-statement.csv");

test("statement import → processing → calculation → posting through the UI", async ({ page }) => {
  await signUpViaApi(page, uniqueEmail("e2e-royalty"), "Royalty Tester");
  const org = await createOrg(page, "E2E Royalties");
  const o = `/organizations/${org.id}`;

  // Catalog + ownership via the API (the catalog UI is covered separately).
  const artist = await bff<{ id: string }>(page, "POST", `${o}/parties`, { name: "Sample Artist", roles: ["artist"] });
  const label = await bff<{ id: string }>(page, "POST", `${o}/parties`, { name: "E2E Label", roles: ["label"] });
  for (const [title, isrc] of [["Sample Song One", "QZSAM2600001"], ["Sample Song Two", "QZSAM2600002"]]) {
    const rec = await bff<{ id: string }>(page, "POST", `${o}/recordings`, { title, isrc, primary_artist_id: artist.id });
    await bff(page, "PUT", `${o}/rights/assets/recording/${rec.id}/splits`, {
      rights_type: "master",
      shares: [
        { party_id: label.id, role: "label", share_percent: "70", territories: ["WORLD"] },
        { party_id: artist.id, role: "artist", share_percent: "30", territories: ["WORLD"] },
      ],
    });
  }

  // Upload wizard.
  await page.goto("/royalties/statements/new");
  await page.getByLabel("Source name").fill("Sample Distributor");
  await page.getByRole("combobox", { name: "Source category" }).click();
  await page.getByRole("option", { name: /distributor/i }).click();
  await page.getByLabel("Period start").fill("2026-03-01");
  await page.getByLabel("Period end").fill("2026-03-31");
  await page.getByLabel("Statement file").setInputFiles(SAMPLE);
  await page.getByRole("button", { name: /upload & continue/i }).click();

  // Mapping step: the distributor adapter is detected automatically.
  await expect(page.getByRole("button", { name: /save mapping & process/i })).toBeVisible();
  await page.getByRole("button", { name: /save mapping & process/i }).click();

  // Processing step: the embedded worker parses and matches the file.
  await expect(page.getByRole("link", { name: /calculate royalties/i })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("link", { name: /calculate royalties/i }).click();

  // Calculation tab → run detail.
  await page.getByRole("tabpanel", { name: "Calculation" }).getByRole("button", { name: /^calculate$/i }).click();
  const confirm = page.getByRole("alertdialog");
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.getByRole("button", { name: /calculate/i }).click();
  }
  await expect(page).toHaveURL(/\/royalties\/runs\//, { timeout: 30_000 });
  await expect(page.getByText(/reconciles exactly/i)).toBeVisible();

  // Exact figures from the API: 4 matched lines (72.25) split 70/30, 1 unmatched (0.16).
  const runId = page.url().split("/runs/")[1].split(/[?#]/)[0];
  const run = await bff<{ total_input: string; total_payable: string; total_retained: string; total_unallocated: string }>(
    page, "GET", `${o}/royalties/runs/${runId}`,
  );
  expect(run.total_input).toBe("72.41000000");
  expect(run.total_unallocated).toBe("0.16000000");
  expect(run.total_payable).toBe("72.25000000");  // both parties are external payees
  expect(run.total_retained).toBe("0.00000000");

  // Post to the ledger (owner ⇒ admin rights).
  await page.getByRole("button", { name: /post to ledger/i }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: /post to ledger/i }).click();
  await expect(page.getByText(/posted to ledger/i).first()).toBeVisible();
  const balances = await bff<{ items: { payee_name: string; balance: string }[] }>(page, "GET", `${o}/ledger/balances`);
  const byName = Object.fromEntries(balances.items.map((b) => [b.payee_name, b.balance]));
  expect(byName).toEqual({ "E2E Label": "50.57500000", "Sample Artist": "21.67500000" });
});

test("another organization's statement is not reachable", async ({ browser }) => {
  const owner = await browser.newPage();
  await signUpViaApi(owner, uniqueEmail("e2e-tenant-a"));
  const orgA = await createOrg(owner, "Tenant A");
  const statement = await bff<{ id: string }>(owner, "POST", `/organizations/${orgA.id}/royalties/statements/manual`, {
    source_name: "Private sync fee", source_category: "licensing", period_start: "2026-01-01",
    period_end: "2026-01-31", currency: "USD", lines: [{ title: "Secret", amount: "999.00" }],
  });

  const intruder = await browser.newPage();
  await signUpViaApi(intruder, uniqueEmail("e2e-tenant-b"));
  await createOrg(intruder, "Tenant B");
  await intruder.goto(`/royalties/statements/${statement.id}`);
  await expect(intruder.getByText("Private sync fee")).toHaveCount(0);
  await expect(intruder.getByText(/not found/i).first()).toBeVisible();
  const direct = await intruder.request.get(`/api/backend/v1/organizations/${orgA.id}/royalties/statements/${statement.id}`);
  expect(direct.status()).toBe(404);
});
