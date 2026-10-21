import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify("0.0.0-test"), __DEV__: "true" },
  test: { include: ["src/**/*.test.ts"], testTimeout: 60_000 },
});
