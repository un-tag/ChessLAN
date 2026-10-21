# ChessLAN

Chess for two people on the same home Wi-Fi, with no internet needed. It
feels like chess.com: a green board, drag or click to move, premoves,
proper clocks, sounds, takebacks and rematches. It also has text and voice
chat, a full game history with replays, separate Bullet / Blitz / Rapid
ratings, and computer opponents from beginner to strong.

One computer (the Mac) **hosts**: it keeps the games, history and ratings.
The other (the Windows PC) **joins**: it finds the Mac on the Wi-Fi by
itself. Both run quietly in the menu bar or tray and start at login, so a
challenge pops up on the other screen even when the app is closed.

## Install

Download the latest files from the
[Releases page](https://github.com/un-tag/ChessLAN/releases/latest).

### On the Mac (host)

1. Download `ChessLAN-<version>-arm64.dmg`, open it, and drag ChessLAN into
   Applications.
2. The app isn't notarized by Apple, so the first launch needs one extra
   step. Right-click ChessLAN in Applications and choose **Open**, then
   **Open** again. If macOS says the app "is damaged", run this once in
   Terminal:
   ```sh
   xattr -dr com.apple.quarantine /Applications/ChessLAN.app
   ```
3. Enter your name and choose **Hosts the games**.
4. Allow microphone access when asked; it's used for voice chat. If the
   macOS firewall is on, allow ChessLAN to accept incoming connections.

The Mac updates itself from GitHub whenever it's online. When an update
has downloaded, Settings shows **Restart to update**.

### On the Windows PC (join)

1. Download `ChessLAN-Setup-<version>.exe` and run it.
2. Windows SmartScreen will say "Windows protected your PC", because the
   app isn't code-signed. Click **More info → Run anyway**.
3. Approve the one admin (UAC) prompt. It adds a Windows Firewall rule for
   ChessLAN so voice chat never asks for permission later. This is the
   only time admin is needed.
4. Enter the player's name and choose **Joins the host**. That's it: the
   app finds the Mac on the Wi-Fi by itself.

You never have to touch this PC again. When the Mac updates, it passes the
matching update to the PC over the home network, and the PC installs it
silently between games.

## Playing

- **1 min** and **10 min** send a challenge to the other player. Their
  window pops up with **Accept / Decline**.
- **More options…** has every chess.com time control (Bullet, Blitz,
  Rapid), custom minutes plus seconds added per move, no clock, colour
  choice, and rated or casual.
- **Moving:** drag or click pieces. During your opponent's turn you can
  queue premoves; right-click or press Esc to cancel them. Right-drag
  draws arrows, right-click marks a square.
- **Promotion:** pawns become queens automatically. To pick a different
  piece, or to be asked every time, change it in Settings.
- **During a game:** you can offer a draw, ask for a takeback (your
  opponent has to accept), or resign. Before both players have moved, you
  can abort instead.
- **Keyboard:** ← / → step through the moves, F flips the board.
- **Voice chat** is live whenever both of you have the app window open.
  Use the 🎙️ button at the top to mute.
- **Play the computer** offers ten levels (about 250 to 2000) and some
  characters with their own style. These games are unrated and work even
  when the Mac is off.
- **History** lists every game; open one to replay it or save it as a PGN
  file. **Stats** shows ratings over time and the head-to-head score.

If Wi-Fi drops mid-game, the game waits: come back within 60 seconds and
carry on. While a game is on, the host Mac won't go to sleep.

## Troubleshooting

- **"Looking for the host on your Wi-Fi…" never goes away**
  - Make sure the Mac is awake, ChessLAN is running there (menu bar icon),
    and both computers are on the same network.
  - Guest networks and "AP/client isolation" router settings stop devices
    seeing each other.
  - As a last resort, type the Mac's address into the PC's Settings → This
    computer. The Mac shows its address in its own Settings → This
    computer.
- **No voice:** check the microphone permission (macOS: System Settings →
  Privacy & Security → Microphone; Windows: Settings → Privacy →
  Microphone).
- **Where the data lives:** everything is in
  `~/Library/Application Support/ChessLAN/hub/` on the Mac. Back up
  `games.jsonl` to keep the history and ratings.

## Development

```sh
npm install
npm run dev        # Vite + Electron with hot reload
npm test           # unit tests (rules/perft, hub, ratings, bot, board)
npm run test:e2e   # builds, then plays real games between two browsers
npm run test:electron  # launches the real app twice (host + joiner); needs a display
npm run hub        # standalone hub; open http://localhost:47800 in a browser
```

- `src/shared`: chess rules, protocol, ratings, time controls, the bot
- `src/hub`: the game server that runs on the Mac
- `src/main`, `src/preload`: the Electron shell
- `src/renderer`: the React UI (`board/` is the chessboard component)

The design and the decisions behind it are in
[docs/DESIGN.md](docs/DESIGN.md).

**Releasing:** bump `version` in `package.json`, commit, then tag and push
(`git tag v3.0.1 && git push --tags`). GitHub Actions builds the Mac and
Windows apps and publishes the release; the Mac picks it up by itself.

## Credits

Chess pieces: the [Kiwen-suwi](https://github.com/neverRare/kiwen-suwi) set
by neverRare, licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
