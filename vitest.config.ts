import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

// Server tests run on node; a UI test file opts into jsdom with `// @vitest-environment jsdom`.
export default defineConfig({
  plugins: [preact()],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "admin-ui/test/**/*.test.{ts,tsx}"],
  },
});
