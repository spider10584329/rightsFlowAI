import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${src}/` },
      // `server-only` throws outside the react-server condition; tests import server modules directly.
      { find: /^server-only$/, replacement: fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)) },
    ],
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    restoreMocks: true,
  },
});
