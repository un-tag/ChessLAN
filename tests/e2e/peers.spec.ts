import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHub } from "../../src/hub/hub";
import { expect, test } from "./fixtures";

test("each app keeps its own history, and they merge when the apps link", async ({ browser, hub, alex }) => {
  // Sam's app is on its own (its own hub) and plays the computer.
  const dir = mkdtempSync(join(tmpdir(), "chesslan-e2e-b-"));
  const samHub = await startHub({ dataDir: dir, appVersion: "e2e", port: 0, host: "127.0.0.1", staticDir: resolve("out/renderer") });
  try {
    const sam = await (await browser.newContext()).newPage();
    await sam.goto(`http://127.0.0.1:${samHub.port}/?id=sam&name=Sam`);
    await sam.getByTestId("play-bot").click();
    await sam.getByTestId("bot-level-1").click();
    await sam.getByRole("button", { name: "♔ White" }).click();
    await sam.getByTestId("start-bot").click();
    await sam.locator('[data-square="e2"]').click();
    await sam.locator('[data-square="e4"]').click();
    await expect(sam.getByTestId("move-list").locator(".move")).toHaveCount(2, { timeout: 15_000 });
    await sam.getByRole("button", { name: /Resign/ }).click();
    await expect(sam.getByTestId("game-over")).toBeVisible();

    // The apps find each other: Sam's hub syncs with Alex's (the referee here)
    // and Sam's UI moves over to it.
    samHub.linkTo(`127.0.0.1:${hub.port}`);
    await sam.goto(`${hub.url}/?id=sam&name=Sam`);
    await expect(alex.page.getByText("Sam is here")).toBeVisible();

    // Alex's hub now has a full copy of Sam's game (History only lists your
    // own games, so this one shows up on Sam's side).
    await expect.poll(() => hub.store.records.map((r) => r.white.id)).toEqual(["sam"]);
    await sam.getByRole("button", { name: "History" }).click();
    await expect(sam.getByTestId("history").locator("tbody tr")).toHaveCount(1);
    await expect(sam.getByTestId("history")).toContainText("Level 1");
  } finally {
    await samHub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
