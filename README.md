# ChessLAN

Chess for two people on the same home Wi-Fi, with no internet needed. It
feels like chess.com: a green board, drag or click to move, premoves,
proper clocks, sounds, takebacks and rematches. It also has text and voice
chat, a full game history with replays, separate Bullet / Blitz / Rapid
ratings, and computer opponents from beginner to strong.

The two apps are equal: each keeps a full copy of every game, the ratings
and the chat, and they find each other on the Wi-Fi by themselves. When both
are running they sync and play; on its own, either app still has the
history, stats and computer opponents. The one thing that isn't shared is
updates: they always come from the Mac. Both apps run quietly in the menu
bar or tray and start at login, so a challenge pops up on the other screen
even when the app is closed.

## Install

Download the latest files from the
[Releases page](https://github.com/un-tag/ChessLAN/releases/latest).

### On the Mac

1. Download `ChessLAN-<version>-arm64.dmg`, open it, and drag ChessLAN into
   Applications.
2. The app isn't notarized by Apple, so the first launch needs one extra
   step. Right-click ChessLAN in Applications and choose **Open**, then
   **Open** again. If macOS says the app "is damaged", run this once in
   Terminal:
   ```sh
   xattr -dr com.apple.quarantine /Applications/ChessLAN.app
   ```
3. Enter your name.
4. Allow microphone access when asked; it's used for voice chat. If the
   macOS firewall is on, allow ChessLAN to accept incoming connections.

The Mac updates itself from GitHub whenever it's online. When an update
has downloaded, Settings shows **Restart to update**.

### On the Windows PC

1. Download `ChessLAN-Setup-<version>.exe` and run it.
2. Windows SmartScreen will say "Windows protected your PC", because the
   app isn't code-signed. Click **More info → Run anyway**.
3. Approve the one admin (UAC) prompt. It adds a Windows Firewall rule for
   ChessLAN so the apps can connect both ways and voice chat never asks for
   permission later. This is the only time admin is needed.
4. Enter the player's name. That's it: the two apps find each other on the
   Wi-Fi by themselves.

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
  when the other computer is off.
- **History** lists every game; open one to replay it or save it as a PGN
  file. **Stats** shows ratings over time and the head-to-head score.

If Wi-Fi drops mid-game, the game waits: come back within 60 seconds and
carry on. While a game is on, neither computer goes to sleep.

When both apps are running, one of them quietly referees each game (keeps
the official clock). It's picked automatically and you never need to know
which; if that app quits mid-game, the game is lost, just as if that player
had left.

## Troubleshooting

- **The top bar says "On your own" while the other app is running**
  - Make sure both computers are awake and on the same network, with
    ChessLAN running on both (menu bar / tray icon).
  - Guest networks and "AP/client isolation" router settings stop devices
    seeing each other.
  - As a last resort, each app shows its own address in Settings → This
    computer; type one computer's address into the other's Settings.
- **No voice:** check the microphone permission (macOS: System Settings →
  Privacy & Security → Microphone; Windows: Settings → Privacy →
  Microphone).
- **Where the data lives:** each computer has a full copy in ChessLAN's
  `hub` folder (`~/Library/Application Support/ChessLAN/hub/` on the Mac,
  `%APPDATA%\ChessLAN\hub\` on Windows). `games.jsonl` holds the history
  and ratings; the two copies back each other up.

## Development

```sh
npm install
npm run dev        # Vite + Electron with hot reload
npm test           # unit tests (rules/perft, hub, ratings, bot, board)
npm run test:e2e   # builds, then plays real games between two browsers
npm run test:electron  # launches the real app twice as two peers; needs a display
npm run hub        # standalone hub; open http://localhost:47800 in a browser
```

- `src/shared`: chess rules, protocol, ratings, time controls, the bot
- `src/hub`: the hub every app runs (games, clocks, history, peer sync)
- `src/main`, `src/preload`: the Electron shell
- `src/renderer`: the React UI (`board/` is the chessboard component)

The design and the decisions behind it are in
[docs/DESIGN.md](docs/DESIGN.md).

**Releasing:** bump `version` in `package.json` and merge it, then on
GitHub open **Actions → Release → Run workflow** (or push a matching tag,
e.g. `git tag v3.1.1 && git push --tags`). It builds the Mac and Windows
apps and publishes the release, creating the tag if needed. The Mac picks
it up by itself and passes it on to the PC.

## Credits

Chess pieces: the [Kiwen-suwi](https://github.com/neverRare/kiwen-suwi) set
by neverRare, licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
