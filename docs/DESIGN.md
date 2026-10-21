# ChessLAN — design

This is the living design document for ChessLAN. It describes the current,
agreed design (not a history of how we got here). The previous WinForms
implementation lives in git history before the v2 rewrite. It is not a
reference: everything here is designed from the goals below. The only
things kept are the ones you chose explicitly (the look).

## Goal

Two brothers play chess against each other at home, as smoothly as on
chess.com, with no internet required.

- **Players:** exactly two people. One is technical and uses an Apple
  Silicon Mac (full admin). The other is not technical and uses a Windows
  PC.
- **Place:** always the same home Wi-Fi.
- **Why not lichess/chess.com:** it must work offline.
- **Trust:** nobody cheats and nobody edits files. Anti-tamper machinery is
  explicitly out of scope.

## Constraints

| Constraint | Consequence |
| --- | --- |
| Works with no internet | Nothing at runtime may depend on a CDN, cloud service, web font or push service. Everything is bundled. |
| Brother never sees a Windows Firewall "Allow" prompt | The Windows app only makes **outbound** connections. Discovery uses outbound TCP probes, never UDP listening. The installer pre-approves the app in Windows Firewall (one UAC at install, done by the technical brother) as a safety net for voice. |
| Brother isn't technical | Starts at login into the tray. Challenges pop the window up. Updates arrive silently from the Mac. Zero settings required. |
| Mac owner has admin | The Mac is the host. A macOS firewall or Gatekeeper prompt there is acceptable. |
| Mac + Windows | One cross-platform codebase. |

## Architecture

**Stack:** Electron + TypeScript, with React for the UI. It's the same
Chromium engine on both machines, so rendering, audio, echo cancellation and
WebRTC behave identically. It can also be developed and tested end to end in
headless Chromium.

```
 Mac (host role)                                Windows (join role)
┌──────────────────────────────┐               ┌──────────────────────────┐
│ Electron main                │               │ Electron main            │
│  ├─ Hub (HTTP+WS :47800)  ◄──┼── ws (TCP) ───┼── renderer (UI)          │
│  │   games, clocks, chat,    │               │  tray, discovery (TCP    │
│  │   history, rtc relay,     │               │  probe), electron-updater│
│  │   serves Windows updates  │               │  (feed = Mac hub)        │
│  └─ renderer (UI) ── ws ─────┤               └──────────────────────────┘
│     tray, GitHub update check│
└──────────────────────────────┘
          ▲  voice: WebRTC peer connection between the two renderers,
          └─ signalled through the hub (LAN host candidates only)
```

- **Hub** (`src/hub`): plain Node, no Electron dependency. It runs inside the
  Mac app's main process and standalone for tests and development. It is the
  single source of truth for games, clocks, chat and history.
- **Renderer** (`src/renderer`): the whole UI. It connects to the hub with a
  WebSocket, including on the Mac (via `127.0.0.1`). It also runs in a plain
  browser when the hub serves it, which is how end-to-end tests run.
- **Shared** (`src/shared`): chess rules, time controls, ratings, protocol
  types and the bot engine. Both the hub and the renderer use it.
- **Main** (`src/main`): window and tray, start at login, single instance,
  hub hosting, discovery, notifications, microphone permission and updates.

### Roles and discovery

- At first run you choose the role: **Host** (default on macOS) or **Join**
  (default on Windows). You can change it later in Settings.
- A joiner finds the host in this order:
  1. The last known address.
  2. A TCP probe of port 47800 across each local IPv4 subnet (up to /22),
     confirmed by `GET /hello`.
  3. A manually entered address (Settings → Advanced).

  All of these are outbound connections.
- The hub listens on TCP 47800. Nothing listens on the Windows machine.

### Background behaviour

- **Starting:** both apps start at login, hidden in the menu bar or tray.
- **Closing:** closing the window hides it. Quit is in the tray menu.
- **Throttling:** the renderer keeps running while hidden
  (`backgroundThrottling: false`) so it stays connected.
- **Challenges:** when a challenge arrives while the window is hidden, the
  main process shows and focuses the window, flashes the taskbar or bounces
  the dock, plays a sound, and shows a native notification.

## Gameplay

### Starting a game

- **Quick buttons:** big **1 min** and **10 min** buttons send a challenge to
  the other player.
- **Advanced:** chess.com's full set of time controls.
  - Bullet: 30 sec, 1 min, 1|1, 2|1
  - Blitz: 3 min, 3|2, 5 min, 5|5
  - Rapid: 10 min, 10|5, 15|10, 30 min, 60 min
  - Custom: minutes plus increment seconds, or untimed
  - Colour: white, random or black
  - Rated or casual
- **Defaults:** random colour, rated.
- **Accepting:** the challenged player gets a popup with Accept / Decline. The
  challenger can cancel.
- **Notation:** "10|5" means 10 minutes plus 5 seconds added per move. The UI
  shows plain words for the quick buttons.

### Rules (enforced by the hub)

- Full legal chess, including castling, en passant, promotion, check and
  checkmate.
- Draws are automatic, chess.com style: stalemate, threefold repetition,
  50-move rule, insufficient material, and timeout against insufficient
  material (the side with time left has only K, K+B or K+N).
- **Abort:** possible until both players have made their first move. Aborted
  games are not recorded.
- **Resign, draw offer, takeback:**
  - Resign asks for confirmation inside the app.
  - A draw offer is shown as a banner. It stays open until the opponent
    moves.
  - A takeback must be accepted by the opponent. It undoes back to the
    requester's turn and is allowed in any game. Clock times are not
    restored.
- **Rematch:** when both players click Rematch, a new game starts with the
  same settings and colours swapped.

### Clocks

- The hub owns the clocks.
- Clocks start after both players have made their first move (lichess
  style).
- **Lag compensation:** each move carries the client's own think time. The
  hub charges `min(clientThinkMs, serverElapsedMs)`, so Wi-Fi latency never
  costs time. This is safe because nobody cheats.
- **Flagging:** the hub flags a player when their time plus a small grace
  period (about 2× measured latency + 150 ms, capped at 1 s) runs out.
- **Display:** clients show the hub's clock snapshot, interpolated with an
  estimated server-time offset taken from ping/pong.

### Disconnects

- **During a game:** the clock keeps running. The opponent sees "Opponent
  disconnected — wins in 60 s".
  - Reconnecting resumes the game.
  - If the player is still gone after 60 s, they lose by abandonment, unless
    the flag falls first.
  - If the disconnect happens before both players have moved, the game is
    aborted instead.
- **When the hub restarts:** an unfinished game is lost. The host is one of
  the two players, so this is acceptable.

### Board feel (current look kept)

- **Look:** chess.com green board (`#EEEED2` / `#769656`), the Kiwen-Suwi
  pieces (CC BY 4.0, credited in the app and README), yellow last-move
  highlight, and coordinates inside the squares.
- **Moving pieces:**
  - Drag-and-drop and click-to-move.
  - Legal-move dots and capture rings (can be turned off).
  - The dragged piece is drawn slightly larger.
- **Premoves:** you can queue several. The queue is client side and is
  submitted the instant your turn begins. Right-click or Esc clears it.
- **Annotations:** right-drag draws an arrow and right-click marks a square;
  a left click clears them.
- **Animation:** ease-out movement, never delaying game logic. It's 100 ms
  for bullet, 150 ms for blitz and 200 ms for rapid or untimed. About 100 ms
  is the shortest that still shows where a piece went.
- **Promotion:** a chess.com-style picker on the board, or auto-queen if
  that setting is on.
- **Sounds:** synthesized at startup from a physical model, with no sample
  files. A piece landing is a sharp contact click plus a few short, damped,
  inharmonic wood resonances (about 200 Hz–3 kHz); a capture is a brighter
  "clack" plus a second impact. Chimes use small-bell partials. There are
  sounds for move, capture, castle, check, promote, game start, game end,
  low time, premove, chat, challenge and illegal move. The opponent's move
  sound plays the instant the move arrives.
- **Material:** captured pieces and a +N material difference are shown next
  to each player.

## Ratings and history

- **The game log is the single source of truth.** The hub stores each
  finished game once, in an append-only JSONL file.
  - A record holds: both players, the time control, rated or not, the UCI
    move list, result, reason, start and end times, and the bot if any.
- **Everything else is derived from the log:** ratings, head-to-head records,
  streaks and rating history.
- **Ratings:**
  - There are separate **Bullet / Blitz / Rapid** ratings, each starting at
    **400**. Elo, K = 32, floor 100.
  - Category is chess.com's: estimated duration = base + 40 × increment;
    under 3 min is bullet, under 10 min is blitz, otherwise rapid.
  - Untimed and casual games are unrated.
- **History:** every game, including bot games, can be browsed and replayed
  move by move (keyboard arrows supported), copied as PGN, or exported to a
  `.pgn` file.
- **Stats:** for each category, both players' ratings with rating history,
  head-to-head W/L/D, current and best streak, plus an overall
  head-to-head.
- **Old data:** none. We are starting fresh.

## Computer opponent

- **Location:** runs locally in a Web Worker, so it works even when the
  other machine is off.
- **Levels 1–10:** from about 250 (makes real beginner blunders) to about
  2000. Weakness comes from limited depth plus noisy or blunder-prone move
  choice at the low levels. Off-the-shelf engines can't play convincingly
  below about 1300, which is why we use our own engine.
- **Personality bots:** named characters with a style (for example a pawn
  pusher, an attacker, a turtle, an early-queen lover, a random mover), each
  at a fixed strength.
- **Rules for bot games:** unrated, untimed by default (a time control is
  optional), instant takebacks. Games are saved to history and queued locally
  if the hub is unreachable.

## Communication

- **Text chat:** always available while connected, in the home screen and in
  games. The hub stores the last 500 messages. You get an unread badge, and
  a notification while the window is hidden.
- **Voice:**
  - **When it's live:** whenever **both** players have the app window open
    (not just the tray process), whether or not a game is on.
  - **Mute:** each side has a mute button. The mute state persists.
  - **Transport:** WebRTC audio with echo cancellation, noise suppression
    and auto gain, so speakers work. Signalling goes through the hub, and
    the connection uses LAN host candidates with no STUN or TURN.
  - **Firewall:** the Windows installer's firewall rule ensures no prompt.

## Updates

- **Releases:** GitHub Actions builds the macOS arm64 app (zip + dmg) and the
  Windows NSIS installer, and attaches them to a GitHub Release when a `v*`
  tag is pushed.
- **Mac (host):**
  - When online, it checks GitHub Releases.
  - If there's a newer version, it downloads the zip and offers
    "Restart to update". It then swaps the app bundle itself, because
    unsigned apps can't use Squirrel.Mac.
  - It keeps a cached copy of the **Windows** update files for its own
    version and serves them at `/updates/win/` on the hub.
- **Windows (join):** electron-updater's feed is the Mac hub. Updates
  download in the background and install silently when no game is in
  progress. The brother never acts.
- **Version mismatch:** the protocol version is checked in `hello`. On a
  mismatch the joiner shows "Updating…", or "Ask the host to update" if no
  matching update is available.

## Packaging

- **macOS:**
  - arm64 only, ad-hoc signed (`identity: "-"`), not notarized.
  - The first launch needs right-click → Open, or
    `xattr -dr com.apple.quarantine`, as documented in the README.
  - Has an `NSMicrophoneUsageDescription`.
- **Windows:**
  - Per-user NSIS installer, so updates need no UAC.
  - On first install only, it runs `netsh advfirewall firewall add rule`
    elevated (one UAC prompt) for the app executable, inbound, all profiles.
  - SmartScreen "Run anyway" appears once, because the app is unsigned.

## Testing

- **Unit tests (Vitest):**
  - Perft-verified move generation.
  - SAN, FEN and PGN.
  - Draw rules.
  - Time-control categories and Elo.
  - Hub game logic with a fake clock.
- **End-to-end (Playwright, headless Chromium):**
  - A standalone hub serves the renderer, with two browser contexts as the
    two brothers.
  - Covers challenge and accept, moves, premoves, flagging, draws,
    takebacks, resign, rematch, chat, voice connection (fake media),
    reconnects, history and ratings.
- **CI** runs both on Linux. Release builds run on macOS and Windows runners.

## Open questions

None currently. New questions are added here as they come up during the
build.
