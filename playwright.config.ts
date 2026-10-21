import { defineConfig } from "@playwright/test";

// End-to-end tests: each test starts its own hub (serving the built UI from
// out/renderer) and drives two browser "players" against it.
export default defineConfig({
  projects: [
    { name: "web", testDir: "tests/e2e" },
    // The real Electron app; needs a display (xvfb-run on Linux).
    { name: "electron", testDir: "tests/electron", fullyParallel: false },
  ],
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "test-results/html" }]] : "list",
  use: {
    browserName: "chromium",
    viewport: { width: 1280, height: 820 },
    permissions: ["microphone"],
    launchOptions: {
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    },
    trace: "retain-on-failure",
  },
  outputDir: "test-results/artifacts",
});
