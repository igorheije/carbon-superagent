import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./src/test-empty.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "bin/**/*.test.mjs"],
    environment: "node",
    // Many tests drive real git and child processes; under CI or parallel load the 5 s default
    // produced timeouts that were not failures.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
