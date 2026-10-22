# ChessLAN — design

This is the living design document for ChessLAN. It describes the current,
agreed design (not a history of how we got here). The previous WinForms
implementation lives in git history before the v3 rewrite. It is not a
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
| Brother never sees a Windows Firewall "Allow" prompt | The installer pre-approves the app in Windows Firewall (one UAC at install, done by the technical brother). If that was declined, the app still works: a link only needs one direction to connect, so the PC can still connect out to the Mac. |
| Brother isn't technical | Starts at login into the tray. Challenges pop the window up. Updates arrive silently from the Mac. Zero settings required. |
| No special computer | The two apps are equal peers. Either can be on its own, and either can referee a game. The single exception is updates, which always come from the Mac (your choice). |
| Mac owner has admin | A macOS firewall or Gatekeeper prompt there is acceptable. |
| Mac + Windows | One cross-platform codebase. |

## Architecture

**Stack:** Electron + TypeScript, with React for the UI. It's the same
Chromium engine on both machines, so rendering, audio, echo cancellation and
WebRTC behave identically. It can also be developed and tested end to end in
headless Chromium.

```
   Mac app (peer)                         Windows app (peer)
 ┌───────────────────────────┐          ┌───────────────────────────┐
 │ hub :47800                │◄─ sync ──│ hub :47800                │
 │  full copy of games,      │  (link)  │  full copy of games,      │
 │  ratings, chat, players   │          │  ratings, chat, players   │
 │ discovery + election      │          │ discovery + election      │
 │ UI ──► referee's hub      │          │ UI ──► referee's hub      │
 └───────────────────────────┘          └───────────────────────────┘
        voice: WebRTC directly between the two UIs (LAN only)
```

- **Every app is the same peer.** Each runs a hub, discovery and the UI.
  There are no roles and nothing to configure.
- **Hub** (`src/hub`): plain Node, no Electron dependency. It holds that
  computer's full copy of the game log, chat and known players, runs live
  games, and syncs with the other peer. It also runs standalone for tests
  and development.
- **Renderer** (`src/renderer`): the whole UI. It connects by WebSocket to
  whichever hub is currently the referee: its own when alone, possibly the
  other computer's when both are up. It also runs in a plain browser when a
  hub serves it, which is how end-to-end tests run.
- **Shared** (`src/shared`): chess rules, time controls, ratings, protocol
  types and the bot engine.
- **Main** (`src/main`): window and tray, start at login, single instance,
  the local hub, discovery and election, notifications, microphone
  permission and updates.

### Finding each other and picking a referee

- **Discovery:** every app listens on TCP 47800 and looks for other
  ChessLAN apps, in this order:
  1. The address that worked last time, or one entered manually in
     Settings.
  2. A TCP probe of 47800 across each local IPv4 subnet (up to /22),
     confirmed by `GET /hello`.

  It keeps looking every few seconds while alone.
- **Referee election:** when two apps see each other, exactly one hub
  referees, decided the same way on both sides:
  - If each can reach the other, the one with the smaller node id wins.
  - If only one direction works (for example a firewall blocks the PC), the
    reachable one wins. Each app asks the other "can you reach me?" through
    `GET /reach` to find out.
- **Following:** the other app's hub links to the referee to sync data both
  ways, and its UI reconnects to the referee's hub. If the referee goes away,
  everything falls back to the app's own hub within seconds.
- **Alone:** an app on its own uses its own hub. Bots, history, stats and
  settings all work, and challenges wait until the other app turns up.
- **Versions:** apps only link when their protocol versions match. A
  mismatched app keeps working on its own and updates itself (see Updates).

### Background behaviour

- **Starting:** both apps start at login, hidden in the menu bar or tray.
- **Closing:** closing the window hides it. Quit is in the tray menu.
- **Throttling:** the renderer keeps running while hidden
  (`backgroundThrottling: false`) so it stays connected.
- **Challenges:** when a challenge arrives while the window is hidden, the
  main process shows and focuses the window, flashes the taskbar or bounces
  the dock, plays a sound, and shows a native notification.

### Knowing what the other side is doing

- **Is the other app there:** a computer that sleeps, crashes or drops off
  the Wi-Fi doesn't close its connections, so silence has to be noticed.
  - Every hub pings every socket (players' UIs and peer links) every 2 s and
    drops any that has been silent for 6 s.
  - Every UI pings its hub every 2 s and reconnects if it gets no answer
    for 6 s.
  - So the other player shows as away within about 8 s, instead of
    whenever TCP gives up (many minutes).
- **What the home screen says:** "here" (window open), "online" (in the
  tray: a challenge will pop up), "playing the computer", "in a game", or
  "can't reach their app". The last one can't tell a closed app from a
  sleeping computer, so it doesn't claim which.
- **Challenge receipt:** see Starting a game.
- **Microphone:** see Communication.

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
- **Receipt:** the challenged app tells the hub once the popup is actually
  on screen (rendered, with the window visible). The challenger sees
  "Sending to Sam…" until then, then "On Sam's screen". While Sam's app
  can't be reached it says the challenge will pop up when it's back. The
  receipt resets if Sam's app disconnects, since the popup has to show again.
- **Who can be challenged:** either player can challenge the other at any
  time, except while one of them is in a live game.
  - Only a game actually in progress counts as busy, and the hub decides
    that from live games. A result screen, or playing the computer, never
    blocks a challenge.
  - A player whose app isn't running can still be challenged. The
    challenge pops up as soon as their app connects.
  - Challenges expire after 10 minutes. Sending a new one replaces your
    previous one.
  - If both players challenge each other with the same time control and
    rated setting, the game simply starts.
- **After a game:** the result card offers Rematch (same settings, colours
  swapped) and new-game buttons (1 min, 10 min, More options), so a
  different game doesn't need a trip back to the home screen.
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
- **When the referee's app quits:** an unfinished game is lost. The referee
  is one of the two players, so this is acceptable.
- **Sleep:** while a game is in progress the app keeps the computer awake
  (`prevent-app-suspension`; the display may still sleep), so the hub
  can't fall asleep mid-game.

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
- **Promotion:** promotes to a queen automatically by default. Settings
  can change the default piece (queen, knight, rook or bishop) or choose
  "Ask", which shows a chess.com-style picker on the board every time.
  Premoved promotions use the default piece, or a queen in "Ask" mode,
  because a picker can't outlive the position it was opened in.
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

- **The game log is the source of truth, and every app has a full copy.**
  The referee records each finished game once, in an append-only JSONL file,
  and the link copies it to the other app. Because records are never edited,
  two copies merge simply by taking every record id from either side. Ratings
  sort games by end time, then id, so both apps compute the same numbers.
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
  optional), instant takebacks. Games are saved to the current hub's log
  (the app's own when alone) and reach the other app at the next sync.

## Communication

- **Text chat:** always available while both apps are linked, in the home
  screen and in games. Both apps keep the last 500 messages. You get an
  unread badge, and a notification while the window is hidden.
- **Voice:**
  - **When it's live:** whenever **both** players have the app window open
    (not just the tray process), whether or not a game is on.
  - **Mute:** each side has a mute button. The mute state persists.
  - **Mic status:** during a call each app reports its microphone state
    with its presence: on, muted, blocked (permission denied), missing (no
    microphone found) or not working (any other error, such as the device
    being in use). The other player's voice pill shows it ("Sam is muted",
    "Sam's mic is blocked"), and your own pill names your own mic's problem.
  - **Transport:** WebRTC audio with echo cancellation, noise suppression
    and auto gain, so speakers work. Signalling goes through the referee's
    hub, and the connection uses LAN host candidates with no STUN or TURN.
  - **Firewall:** the Windows installer's firewall rule ensures no prompt.

## Updates

- **Releases:** GitHub Actions builds the macOS arm64 app (zip + dmg) and the
  Windows NSIS installer for the version in `package.json`. It's started
  from Actions → Release → Run workflow, or by pushing a matching `v*` tag.
  The release stays a draft until both uploads finish, and publishing it
  creates the tag.
- **Updates are the one centralized thing: they come from the Mac.**
  - **Mac:** when online, checks GitHub Releases. If there's a newer
    version, it downloads the zip and offers "Restart to update". It then
    swaps the app bundle itself, because unsigned apps can't use
    Squirrel.Mac.
  - **Mac's copy for Windows:** the Mac keeps the **Windows** update for its
    own version and serves it at `/updates/win/` on its hub, whatever the
    referee election says.
  - **Windows:** never contacts GitHub. electron-updater's feed is the Mac
    peer, found by discovery (`/hello` says which peer serves Windows
    updates). Updates download in the background and install silently when
    no game is in progress. The brother never acts.
- **Version mismatch:** peers with different protocol versions don't link
  and each keeps working on its own. The Mac updates from GitHub; the PC then
  updates from the Mac, which brings them back in step.

## Packaging

- **macOS:**
  - arm64 only, ad-hoc signed (`identity: "-"`), not notarized.
  - The first launch needs right-click → Open, or
    `xattr -dr com.apple.quarantine`, as documented in the README.
  - Has an `NSMicrophoneUsageDescription`.
  - Has no app category on purpose. A games category makes macOS hook the
    app into its gaming features (Game Mode, the Games app, Game Center),
    which we don't want.
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
  - Peer sync (merging logs both ways, live pushes) and referee election.
  - Dropping silent sockets, challenge receipts and mic status.
- **End-to-end (Playwright, headless Chromium):**
  - A standalone hub serves the renderer, with two browser contexts as the
    two brothers.
  - Covers challenge and accept, moves, premoves, flagging, draws,
    takebacks, resign, rematch, chat, voice connection (fake media),
    reconnects, history and ratings.
- **Real app (Playwright + Electron, under xvfb):** launches the app twice
  as two peers (on different ports) and checks:
  - Discovery and election.
  - History syncing both ways.
  - A challenge played across both windows.
  - The bot's Web Worker loading from `file://`.
  - A challenge popping a window back up from the tray.
  - An app frozen like a sleeping computer (SIGSTOP) showing as away within
    seconds, on either side of the election, and coming back on SIGCONT.
  - Falling back to solo when the referee quits.
- **CI** runs all three on Linux. Release builds run on macOS and Windows
  runners.

## Open questions

None currently. New questions are added here as they come up during the
build.
