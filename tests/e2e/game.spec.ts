import { expect, move, moveList, play, square, startGame, test } from "./fixtures";

test("challenge, checkmate, rating change, rematch and history", async ({ alex, sam }) => {
  const [white, black] = await startGame(alex, sam, "play-1");
  await play(white, black, ["f2f3", "e7e5", "g2g4", "d8h4"]);

  await expect(black.page.getByTestId("game-over")).toContainText("You won!");
  await expect(black.page.getByTestId("game-over")).toContainText("by checkmate");
  await expect(black.page.getByTestId("game-over")).toContainText("Bullet 416 +16");
  await expect(white.page.getByTestId("game-over")).toContainText(`${black.name} won`);
  await expect(white.page.getByTestId("game-over")).toContainText("Bullet 384 -16");

  // Rematch swaps colours.
  await white.page.getByRole("button", { name: "Rematch" }).click();
  await black.page.getByRole("button", { name: /wants a rematch/ }).click();
  await expect(white.page.getByTestId("game-over")).toBeHidden();
  await expect(white.page.getByRole("grid", { name: "Chess board" })).toHaveAttribute("data-orientation", "b");

  // Abort the rematch: aborted games are not recorded.
  await white.page.getByRole("button", { name: "Abort" }).click();
  await expect(white.page.getByTestId("game-over")).toContainText("Game aborted");

  await white.page.getByRole("button", { name: "History" }).click();
  const rows = white.page.getByTestId("history").locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Lost");
  await expect(rows.first()).toContainText("-16");

  // Replay the game move by move.
  await rows.first().click();
  await expect(moveList(white.page)).toContainText("Qh4#");
  await white.page.keyboard.press("Home");
  await expect(square(white.page, "f2")).toHaveAttribute("data-occupant", "wP");
  await white.page.keyboard.press("ArrowRight");
  await expect(square(white.page, "f3")).toHaveAttribute("data-occupant", "wP");
});

test("a queued premove plays the instant the opponent moves", async ({ alex, sam }) => {
  const [white, black] = await startGame(alex, sam);
  await play(white, black, ["e2e4"]);
  // White queues d2-d4 during black's turn.
  await move(white.page, "d2", "d4");
  await expect(square(white.page, "d2")).toHaveAttribute("data-premove", /.*/);
  await move(black.page, "e7", "e5");
  await expect(square(black.page, "d4")).toHaveAttribute("data-occupant", "wP");
  await expect(moveList(black.page)).toContainText("d4");
  await expect(square(white.page, "d2")).not.toHaveAttribute("data-premove", /.*/);
});

test("takeback and draw offers need the opponent's consent", async ({ alex, sam }) => {
  const [white, black] = await startGame(alex, sam);
  await play(white, black, ["e2e4", "e7e5"]);

  await white.page.getByRole("button", { name: /Takeback/ }).click();
  await expect(black.page.getByText(`${white.name} asks to take back`)).toBeVisible();
  await black.page.getByRole("button", { name: "Accept" }).click();
  // Back to white's turn: both plies undone.
  await expect(moveList(white.page)).toContainText("No moves yet");
  await expect(square(white.page, "e2")).toHaveAttribute("data-occupant", "wP");

  await play(white, black, ["d2d4", "d7d5"]);
  await black.page.getByRole("button", { name: /Draw/ }).click();
  await expect(white.page.getByText(`${black.name} offers a draw`)).toBeVisible();
  await white.page.getByRole("button", { name: "Decline" }).click();
  await expect(white.page.getByText(`${black.name} offers a draw`)).toBeHidden();
  await black.page.getByRole("button", { name: /Draw/ }).click();
  await white.page.getByRole("button", { name: "Accept" }).click();
  await expect(black.page.getByTestId("game-over")).toContainText("Draw");
  await expect(black.page.getByTestId("game-over")).toContainText("by agreement");
});

test("resigning needs a confirmation", async ({ alex, sam }) => {
  const [white, black] = await startGame(alex, sam);
  await play(white, black, ["e2e4", "e7e5"]);
  await black.page.getByRole("button", { name: /Resign/ }).click();
  await black.page.getByRole("button", { name: "Keep playing" }).click();
  await expect(white.page.getByTestId("game-over")).toBeHidden();
  await black.page.getByRole("button", { name: /Resign/ }).click();
  await black.page.getByRole("button", { name: "Yes, resign" }).click();
  await expect(white.page.getByTestId("game-over")).toContainText("You won!");
  await expect(white.page.getByTestId("game-over")).toContainText("by resignation");
});

test("a dropped player can come back to the same game", async ({ alex, sam }) => {
  const [white, black] = await startGame(alex, sam);
  await play(white, black, ["e2e4", "c7c5"]);
  await black.close();
  await expect(white.page.getByText(`${black.name} disconnected`)).toBeVisible();
  await black.open();
  await expect(moveList(black.page)).toContainText("c5");
  await expect(white.page.getByText(`${black.name} disconnected`)).toBeHidden();
  await play(white, black, ["g1f3"]);
});

test("declined challenges tell the challenger", async ({ alex, sam }) => {
  await expect(alex.page.getByText("Sam is here")).toBeVisible();
  await alex.page.getByTestId("play-1").click();
  await expect(alex.page.getByText("Waiting for Sam to accept")).toBeVisible();
  await sam.page.getByTestId("decline").click();
  await expect(alex.page.getByText("Sam declined your challenge")).toBeVisible();
  await expect(alex.page.getByTestId("play-1")).toBeEnabled();
});

test("advanced options pick a time control and colour", async ({ alex, sam }) => {
  await alex.page.getByRole("button", { name: "More options…" }).click();
  await alex.page.getByRole("button", { name: "3 | 2" }).click();
  await alex.page.getByRole("button", { name: "♚ Black" }).click();
  await alex.page.getByRole("button", { name: /Challenge Sam · 3 \| 2/ }).click();
  await expect(sam.page.getByText("3 | 2")).toBeVisible();
  await expect(sam.page.getByText("you play white")).toBeVisible();
  await sam.page.getByTestId("accept").click();
  await expect(alex.page.getByRole("grid", { name: "Chess board" })).toHaveAttribute("data-orientation", "b");
  await expect(alex.page.getByText("3 | 2 · Rated Blitz")).toBeVisible();
  await expect(alex.page.getByTestId("clock").first()).toHaveText("3:00");
});

test("pawns promote to a queen by default, or ask when set to", async ({ alex, sam }) => {
  const [white, black] = await startGame(alex, sam);
  await play(white, black, ["a2a4", "h7h5", "a4a5", "h5h4", "a5a6", "h4h3", "a6b7", "h3g2", "b7a8"]);
  await expect(square(black.page, "a8")).toHaveAttribute("data-occupant", "wQ");
  await expect(moveList(black.page)).toContainText("bxa8=Q");

  // Black switches to "Ask" in settings, then promotes by choosing a knight.
  await black.page.getByRole("button", { name: "Settings" }).click();
  await black.page.getByRole("radio", { name: "Ask" }).click();
  await black.page.getByRole("button", { name: "Back to game" }).click();
  await move(black.page, "g2", "h1");
  await black.page.locator('[data-promotion="n"]').click();
  await expect(square(white.page, "h1")).toHaveAttribute("data-occupant", "bN");
  await expect(moveList(white.page)).toContainText("gxh1=N");
});
