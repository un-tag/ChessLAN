import { expect, test } from "./fixtures";

test("text chat reaches the other player and is kept", async ({ alex, sam }) => {
  await alex.page.getByPlaceholder("Send a message…").fill("ready for revenge?");
  await alex.page.keyboard.press("Enter");
  await expect(sam.page.getByTestId("chat")).toContainText("ready for revenge?");
  await sam.close();
  await sam.open();
  await expect(sam.page.getByTestId("chat")).toContainText("ready for revenge?");
});

test("voice connects while both apps are open, and can be muted", async ({ alex, sam }) => {
  await expect(alex.page.getByTestId("voice")).toContainText("Voice with Sam");
  await expect(sam.page.getByTestId("voice")).toContainText("Voice with Alex");
  await alex.page.getByRole("button", { name: "Mute microphone" }).click();
  await expect(alex.page.getByRole("button", { name: "Unmute microphone" })).toBeVisible();
  // Sam closes the app: Alex's side waits for them to come back.
  await sam.close();
  await expect(alex.page.getByTestId("voice")).toContainText("Voice starts when Sam opens the app");
  await sam.open();
  await expect(alex.page.getByTestId("voice")).toContainText("Voice with Sam");
});

test("first launch asks for a name", async ({ browser, hub }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(hub.url);
  await page.getByPlaceholder("Your name").fill("Robin");
  await page.getByRole("button", { name: "Let's play" }).click();
  await expect(page.locator('[data-conn="connected"]')).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Name")).toHaveValue("Robin");
});

test("the computer plays back and the game lands in history", async ({ alex }) => {
  const page = alex.page;
  await page.getByTestId("play-bot").click();
  await page.getByTestId("bot-level-3").click();
  await page.getByRole("button", { name: "♔ White" }).click();
  await page.getByTestId("start-bot").click();
  await page.locator('[data-square="e2"]').click();
  await page.locator('[data-square="e4"]').click();
  await expect(page.getByTestId("move-list").locator(".move")).toHaveCount(2, { timeout: 15_000 });
  await page.getByRole("button", { name: /Resign/ }).click();
  await expect(page.getByTestId("game-over")).toContainText("won");
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.getByTestId("history").locator("tbody tr")).toHaveCount(1);
  await expect(page.getByTestId("history")).toContainText("Level 3");
});
