import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests against the real stack (Next.js dev server + FastAPI +
 * MariaDB). Each test registers its own throwaway users and organizations,
 * so existing data is never touched.
 *
 *   npm run test:e2e
 *
 * Uses the locally installed Google Chrome (`channel: "chrome"`), so no
 * browser download is needed. Set E2E_BASE_URL to target another server.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000/login",
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
