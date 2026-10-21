import { test as base, expect, type Browser, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHub, type Hub } from "../../src/hub/hub";

export interface Player {
  page: Page;
  name: string;
  /** Opens (or reopens) this player's app. */
  open(): Promise<void>;
  close(): Promise<void>;
}

interface Fixtures {
  hub: Hub & { url: string };
  alex: Player;
  sam: Player;
}

async function makePlayer(browser: Browser, url: string, id: string, name: string): Promise<Player> {
  const context = await browser.newContext();
  const player: Player = {
    page: await context.newPage(),
    name,
    async open() {
      if (player.page.isClosed()) player.page = await context.newPage();
      player.page.on("pageerror", (e) => console.log(`[${name}] page error: ${e.message}`));
      await player.page.goto(`${url}/?id=${id}&name=${name}`);
      await expect(player.page.locator(".conn-pill.connected")).toBeVisible();
    },
    async close() {
      await player.page.close();
    },
  };
  return player;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  hub: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), "chesslan-e2e-"));
    const hub = await startHub({
      dataDir: dir,
      appVersion: "e2e",
      port: 0,
      host: "127.0.0.1",
      hostName: "Test Mac",
      staticDir: resolve("out/renderer"),
    });
    await use({ ...hub, url: `http://127.0.0.1:${hub.port}` });
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  },
  alex: async ({ browser, hub }, use) => {
    const p = await makePlayer(browser, hub.url, "alex", "Alex");
    await p.open();
    await use(p);
    await p.page.context().close();
  },
  sam: async ({ browser, hub }, use) => {
    const p = await makePlayer(browser, hub.url, "sam", "Sam");
    await p.open();
    await use(p);
    await p.page.context().close();
  },
});

export { expect };

export const square = (page: Page, sq: string) => page.locator(`[data-square="${sq}"]`);

/** Click-to-move from one square to another. */
export async function move(page: Page, from: string, to: string): Promise<void> {
  await square(page, from).click();
  await square(page, to).click();
}

export const moveList = (page: Page) => page.getByTestId("move-list");

/** Alex challenges Sam to a 10-minute game; returns [white, black]. */
export async function startGame(alex: Player, sam: Player, button: "play-1" | "play-10" = "play-10"): Promise<[Player, Player]> {
  await expect(alex.page.getByText("Sam is here")).toBeVisible();
  await alex.page.getByTestId(button).click();
  await sam.page.getByTestId("accept").click();
  await expect(alex.page.getByRole("grid", { name: "Chess board" })).toBeVisible();
  await expect(sam.page.getByRole("grid", { name: "Chess board" })).toBeVisible();
  const alexWhite = (await alex.page.getByRole("grid", { name: "Chess board" }).getAttribute("data-orientation")) === "w";
  return alexWhite ? [alex, sam] : [sam, alex];
}

/** Plays a sequence of UCI moves, alternating white and black. */
export async function play(white: Player, black: Player, moves: string[]): Promise<void> {
  for (const [i, m] of moves.entries()) {
    const p = i % 2 === 0 ? white : black;
    const other = i % 2 === 0 ? black : white;
    await move(p.page, m.slice(0, 2), m.slice(2, 4));
    // Wait until the other side has received it before continuing.
    await expect(square(other.page, m.slice(2, 4))).toHaveAttribute("data-last-move", /.*/);
  }
}
