import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const PASSWORD = "E2e-Secure-Passw0rd!";

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function csrfToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  let token = cookies.find((c) => c.name === "rf_csrf")?.value;
  if (!token) {
    await page.request.get("/api/auth/csrf");
    token = (await page.context().cookies()).find((c) => c.name === "rf_csrf")?.value;
  }
  if (!token) throw new Error("No CSRF cookie");
  return token;
}

/** Call the backend through the BFF with the page's session cookies. */
export async function bff<T = unknown>(
  page: Page,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const request: APIRequestContext = page.request;
  const origin = new URL(page.url() === "about:blank" ? "http://localhost:3000" : page.url()).origin;
  const response = await request.fetch(`/api/backend/v1${path}`, {
    method,
    data: body === undefined ? undefined : body,
    headers: method === "GET" ? {} : { "x-csrf-token": await csrfToken(page), origin },
  });
  const text = await response.text();
  if (!response.ok()) throw new Error(`${method} ${path} -> ${response.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** Register + sign in through the BFF (sets httpOnly session cookies). */
export async function signUpViaApi(page: Page, email: string, fullName = "E2E User"): Promise<void> {
  await page.goto("/login");
  const response = await page.request.post("/api/auth/register", {
    data: { email, full_name: fullName, password: PASSWORD },
    headers: { origin: "http://localhost:3000" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

export async function createOrg(page: Page, name: string): Promise<{ id: string; slug: string }> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`.slice(0, 90);
  const org = await bff<{ id: string; slug: string }>(page, "POST", "/organizations", { name, slug });
  await bff(page, "PUT", "/auth/me/active-organization", { organization_id: org.id });
  return org;
}
