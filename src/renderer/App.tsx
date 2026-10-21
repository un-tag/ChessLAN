import { useEffect } from "react";
import type { Side } from "../shared/chess/game";
import { ONE_MIN, TEN_MIN, formatTimeControl } from "../shared/timeControl";
import { Modal } from "./components/common";
import { connection } from "./net/connection";
import { platform } from "./platform";
import { BotScreen } from "./screens/BotScreen";
import { GameScreen } from "./screens/GameScreen";
import { History, Replay } from "./screens/History";
import { Home, sendChallenge } from "./screens/Home";
import { Settings } from "./screens/Settings";
import { Setup } from "./screens/Setup";
import { Stats } from "./screens/Stats";
import { unlockAudio } from "./sound";
import { get, myId, navigate, opponent, set, setPrefs, useStore, type Screen } from "./state/store";
import { voice } from "./voice";

export function App() {
  const screen = useStore((s) => s.screen);
  const ready = useStore((s) => s.config !== null);

  useEffect(() => {
    void (async () => {
      const config = await platform.getConfig();
      set({ config, windowVisible: await platform.isVisible() });
      if (!config.player) navigate({ name: "setup" });
      else connection.start();
    })();
    const offs = [
      platform.onVisibility((visible) => {
        set({ windowVisible: visible });
        connection.sendPresence();
        voice.update();
      }),
      platform.onTrayAction((action) => {
        if (action === "challenge-1") sendChallenge({ tc: ONE_MIN, color: "random", rated: true });
        if (action === "challenge-10") sendChallenge({ tc: TEN_MIN, color: "random", rated: true });
      }),
      platform.onUpdateStatus((update) => set({ update })),
    ];
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    // Tell the hub what we're doing whenever the screen changes.
    const unsub = useStore.subscribe((s, prev) => {
      if (s.screen.name !== prev.screen.name) connection.sendPresence();
    });
    return () => {
      offs.forEach((off) => off());
      unsub();
    };
  }, []);

  if (!ready) return null;
  return (
    <div className={`app screen-${screen.name}`}>
      {screen.name !== "setup" && <TopBar screen={screen} />}
      <div className="content">
        <ScreenView screen={screen} />
      </div>
      <IncomingChallenge />
      <Toasts />
    </div>
  );
}

function ScreenView({ screen }: { screen: Screen }) {
  switch (screen.name) {
    case "setup":
      return <Setup />;
    case "home":
      return <Home />;
    case "game":
      return <GameScreen />;
    case "bot":
      return <BotScreen key={screen.key} botId={screen.botId} tc={screen.tc} color={screen.color} />;
    case "history":
      return <History />;
    case "replay":
      return <Replay id={screen.id} />;
    case "stats":
      return <Stats />;
    case "settings":
      return <Settings />;
  }
}

function TopBar({ screen }: { screen: Screen }) {
  const s = useStore();
  const liveGame = s.game && !s.game.over ? s.game : null;
  const nav: { name: "home" | "history" | "stats" | "settings"; label: string }[] = [
    { name: "home", label: "Play" },
    { name: "history", label: "History" },
    { name: "stats", label: "Stats" },
    { name: "settings", label: "Settings" },
  ];
  const opp = opponent(s);
  const connText =
    s.conn === "connected"
      ? s.config?.role === "host"
        ? "Hosting"
        : `Connected to ${s.hub?.hostName || "host"}`
      : s.conn === "mismatch"
        ? "Updating…"
        : s.config?.role === "host"
          ? "Starting…"
          : "Looking for host…";
  return (
    <header className="topbar">
      <button className="brand" onClick={() => navigate({ name: "home" })}>
        <span className="logo">♞</span> ChessLAN
      </button>
      <nav>
        {nav.map((n) => (
          <button key={n.name} className={screen.name === n.name ? "active" : ""} onClick={() => navigate({ name: n.name })}>
            {n.label}
            {n.name === "home" && s.unread > 0 && screen.name !== "home" && <span className="unread">{s.unread}</span>}
          </button>
        ))}
        {liveGame && screen.name !== "game" && (
          <button className="live" onClick={() => navigate({ name: "game" })}>
            ● Back to game
          </button>
        )}
      </nav>
      <div className="topbar-right">
        <VoicePill opponentName={opp?.name} />
        <span className={`conn-pill ${s.conn}`} title={s.hub?.host}>
          <span className="dot" /> {connText}
        </span>
      </div>
    </header>
  );
}

function VoicePill({ opponentName }: { opponentName?: string }) {
  const status = useStore((s) => s.voice);
  const muted = useStore((s) => s.prefs.micMuted);
  const talking = useStore((s) => s.remoteTalking);
  if (status === "off") return null;
  const label =
    status === "connected"
      ? `Voice with ${opponentName ?? "opponent"}`
      : status === "connecting"
        ? "Voice connecting…"
        : status === "no-mic"
          ? "No microphone"
          : `Voice starts when ${opponentName ?? "they"} open${opponentName ? "s" : ""} the app`;
  return (
    <div className={`voice-pill ${status} ${talking ? "talking" : ""}`} data-testid="voice">
      <span className="voice-label">{label}</span>
      {(status === "connected" || status === "connecting") && (
        <button
          className={`mute ${muted ? "muted" : ""}`}
          title={muted ? "Unmute microphone" : "Mute microphone"}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          onClick={() => {
            setPrefs({ micMuted: !muted });
            voice.setMuted(!muted);
          }}
        >
          {muted ? "🔇" : "🎙️"}
        </button>
      )}
    </div>
  );
}

function IncomingChallenge() {
  const challenges = useStore((s) => s.challenges);
  const ch = challenges.find((c) => c.to.id === myId());
  if (!ch) return null;
  const mine: Side | "random" = ch.color === "white" ? "b" : ch.color === "black" ? "w" : "random";
  const respond = (accept: boolean) => {
    connection.send({ type: "challengeRespond", id: ch.id, accept });
    if (accept && get().screen.name === "bot") navigate({ name: "home" });
  };
  return (
    <Modal className="challenge" onClose={() => {}}>
      <div className="challenge-icon">⚔️</div>
      <h2>{ch.from.name} challenges you!</h2>
      <p className="challenge-tc">{formatTimeControl(ch.tc)}</p>
      <p className="muted">
        {ch.rated ? "Rated" : "Casual"} · you play {mine === "random" ? "a random colour" : mine === "w" ? "white" : "black"}
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={() => respond(false)} data-testid="decline">
          Decline
        </button>
        <button className="btn primary huge-ish" autoFocus onClick={() => respond(true)} data-testid="accept">
          Accept
        </button>
      </div>
    </Modal>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
