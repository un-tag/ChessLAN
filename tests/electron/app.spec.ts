// Launches the real Electron app twice — a host and a joiner — and plays
// between the two windows. Needs a display: run under xvfb on Linux.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface App {
  app: ElectronApplication;
  page: Page;
  dir: string;
}

async function launch(config: object): Promise<App> {
  const dir = mkdtempSync(join(tmpdir(), "chesslan-electron-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ startAtLogin: false, ...config }));
  const args = [resolve("."), `--user-data-dir=${dir}`, "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
  if (process.getuid?.() === 0) args.push("--no-sandbox");
  const app = await electron.launch({ args });
  const page = await app.firstWindow();
  return { app, page, dir };
}

async function quit(a: App): Promise<void> {
  await a.app.close();
  rmSync(a.dir, { recursive: true, force: true });
}

test.describe.configure({ mode: "serial" });

let host: App;
let joiner: App;

test.beforeAll(async () => {
  host = await launch({ player: { id: "alex", name: "Alex" }, role: "host" });
  joiner = await launch({ player: { id: "sam", name: "Sam" }, role: "join", hubAddress: "127.0.0.1" });
});

test.afterAll(async () => {
  await quit(joiner);
  await quit(host);
});

test("the joiner finds the host and both see each other", async () => {
  await expect(host.page.locator(".conn-pill")).toContainText("Hosting");
  await expect(joiner.page.locator(".conn-pill")).toContainText("Connected to");
  await expect(host.page.getByText("Sam is here")).toBeVisible();
  await expect(joiner.page.getByText("Alex is here")).toBeVisible();
});

test("a challenge pops up and the game plays across both apps", async () => {
  await joiner.page.getByTestId("play-1").click();
  await host.page.getByTestId("accept").click();
  const board = (p: Page) => p.getByRole("grid", { name: "Chess board" });
  await expect(board(host.page)).toBeVisible();
  const hostWhite = (await board(host.page).getAttribute("data-orientation")) === "w";
  const [white, black] = hostWhite ? [host.page, joiner.page] : [joiner.page, host.page];
  await white.locator('[data-square="e2"]').click();
  await white.locator('[data-square="e4"]').click();
  await expect(black.locator('[data-square="e4"]')).toHaveAttribute("data-occupant", "wP");
  await black.getByRole("button", { name: "Abort" }).click();
  await expect(white.getByTestId("game-over")).toContainText("Game aborted");
  await white.getByRole("button", { name: "Home" }).click();
  await black.getByRole("button", { name: "Home" }).click();
});

test("the bot worker runs inside the packaged UI", async () => {
  const page = host.page;
  await page.getByTestId("play-bot").click();
  await page.getByTestId("bot-level-1").click();
  await page.getByRole("button", { name: "♔ White" }).click();
  await page.getByTestId("start-bot").click();
  await page.locator('[data-square="d2"]').click();
  await page.locator('[data-square="d4"]').click();
  await expect(page.getByTestId("move-list").locator(".move")).toHaveCount(2, { timeout: 15_000 });
});

test("closing the window keeps the app running in the tray", async () => {
  await host.page.getByRole("button", { name: "Play" }).click();
  await host.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => host.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  // The joiner sees the host as online but with its window closed.
  await joiner.page.getByRole("button", { name: "Play" }).click();
  await expect(joiner.page.getByText("a challenge will pop up on their screen")).toBeVisible();
  // A challenge brings the host's window back.
  await joiner.page.getByTestId("play-10").click();
  await expect.poll(() => host.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await host.page.getByTestId("decline").click();
});
