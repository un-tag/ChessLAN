// Launches the real Electron app twice, as two peers on different ports
// pointed at each other, and plays between the two windows. Needs a display:
// run under xvfb on Linux.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface App {
  app: ElectronApplication;
  page: Page;
  dir: string;
  port: number;
  closed: boolean;
}

const ALEX_PORT = 47811;
const SAM_PORT = 47812;

async function launch(port: number, config: object): Promise<App> {
  const dir = mkdtempSync(join(tmpdir(), "chesslan-electron-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ startAtLogin: false, ...config }));
  const args = [resolve("."), `--user-data-dir=${dir}`, "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
  if (process.getuid?.() === 0) args.push("--no-sandbox");
  const app = await electron.launch({ args, env: { ...process.env, CHESSLAN_PORT: String(port) } });
  const page = await app.firstWindow();
  return { app, page, dir, port, closed: false };
}

async function quit(a: App): Promise<void> {
  if (!a.closed) await a.app.close();
  a.closed = true;
  rmSync(a.dir, { recursive: true, force: true });
}

const nodeId = async (port: number): Promise<string> => (await (await fetch(`http://127.0.0.1:${port}/hello`)).json()).nodeId;
const windowVisible = (a: App) => a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());

test.describe.configure({ mode: "serial" });

let alex: App;
let sam: App;

test.beforeAll(async () => {
  alex = await launch(ALEX_PORT, { player: { id: "alex", name: "Alex" }, peerAddress: `127.0.0.1:${SAM_PORT}` });
  sam = await launch(SAM_PORT, { player: { id: "sam", name: "Sam" }, peerAddress: `127.0.0.1:${ALEX_PORT}` });
});

test.afterAll(async () => {
  await quit(sam);
  await quit(alex);
});

test("the two apps find each other and agree on a referee", async () => {
  await expect(alex.page.locator(".conn-pill")).toContainText("With Sam", { timeout: 20_000 });
  await expect(sam.page.locator(".conn-pill")).toContainText("With Alex", { timeout: 20_000 });
  await expect(alex.page.getByText("Sam is here")).toBeVisible();
  await expect(sam.page.getByText("Alex is here")).toBeVisible();
});

test("a challenge pops up and the game plays across both apps", async () => {
  await sam.page.getByTestId("play-1").click();
  await alex.page.getByTestId("accept").click();
  const board = (p: Page) => p.getByRole("grid", { name: "Chess board" });
  await expect(board(alex.page)).toBeVisible();
  const alexWhite = (await board(alex.page).getAttribute("data-orientation")) === "w";
  const [white, black] = alexWhite ? [alex.page, sam.page] : [sam.page, alex.page];
  await white.locator('[data-square="e2"]').click();
  await white.locator('[data-square="e4"]').click();
  await expect(black.locator('[data-square="e4"]')).toHaveAttribute("data-occupant", "wP");
  await black.getByRole("button", { name: "Abort" }).click();
  await expect(white.getByTestId("game-over")).toContainText("Game aborted");
  await white.getByRole("button", { name: "Home" }).click();
  await black.getByRole("button", { name: "Home" }).click();
});

test("the bot worker runs inside the packaged UI", async () => {
  const page = alex.page;
  await page.getByTestId("play-bot").click();
  await page.getByTestId("bot-level-1").click();
  await page.getByRole("button", { name: "♔ White" }).click();
  await page.getByTestId("start-bot").click();
  await page.locator('[data-square="d2"]').click();
  await page.locator('[data-square="d4"]').click();
  await expect(page.getByTestId("move-list").locator(".move")).toHaveCount(2, { timeout: 15_000 });
  await page.getByRole("button", { name: /Resign/ }).click();
  await expect(page.getByTestId("game-over")).toBeVisible();
  await page.getByRole("button", { name: "Play", exact: true }).click();
});

test("closing the window keeps the app running in the tray", async () => {
  await alex.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => windowVisible(alex)).toBe(false);
  await expect(sam.page.getByText("a challenge will pop up on their screen")).toBeVisible();
  // A challenge brings Alex's window back.
  await sam.page.getByTestId("play-10").click();
  await expect.poll(() => windowVisible(alex)).toBe(true);
  await alex.page.getByTestId("decline").click();
});

test("when the referee quits, the other app carries on alone with the full history", async () => {
  test.setTimeout(60_000);
  const [referee, other] = (await nodeId(ALEX_PORT)) < (await nodeId(SAM_PORT)) ? [alex, sam] : [sam, alex];
  await quit(referee);
  await expect(other.page.locator(".conn-pill")).toContainText("On your own", { timeout: 30_000 });
  // Alex's game against the computer is in the survivor's own copy of the log.
  expect(readFileSync(join(other.dir, "hub", "games.jsonl"), "utf8")).toContain("Level 1");
  if (other === alex) {
    await alex.page.getByRole("button", { name: "History" }).click();
    await expect(alex.page.getByTestId("history")).toContainText("Level 1");
  } else {
    await sam.page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(sam.page.getByText("Alex's app isn't running")).toBeVisible();
  }
});
