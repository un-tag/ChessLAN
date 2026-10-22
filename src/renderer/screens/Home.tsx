import { useEffect, useMemo, useState } from "react";
import type { ChallengeSpec, ColorChoice, PlayerPresence } from "../../shared/protocol";
import { computeRatings, headToHead, ratingsFor } from "../../shared/ratings";
import {
  ONE_MIN,
  PRESETS,
  RATED_CATEGORIES,
  TEN_MIN,
  categoryLabel,
  formatTimeControl,
  type TimeControl,
} from "../../shared/timeControl";
import { Chat } from "../components/Chat";
import { Modal, Toggle, timeAgo } from "../components/common";
import { connection } from "../net/connection";
import { isDesktop, platform } from "../platform";
import { myId, navigate, opponent, set, useStore } from "../state/store";
import { BotPicker } from "./BotPicker";
import { recordOutcome, reasonText } from "./results";

export function sendChallenge(spec: ChallengeSpec): void {
  const opp = opponent();
  if (!opp) return;
  connection.send({ type: "challenge", to: opp.id, spec });
}

export function Home() {
  const s = useStore();
  const me = myId();
  const opp = opponent(s);
  const others = s.players.filter((p) => p.id !== me);
  const [advanced, setAdvanced] = useState(false);
  const [botPicker, setBotPicker] = useState(false);
  const outgoing = s.challenges.find((c) => c.from.id === me);
  const connected = s.conn === "connected";
  // Offline players can be challenged too: it pops up when their app opens.
  const canChallenge = connected && !!opp && opp.activity !== "game" && !outgoing;

  const ratings = useMemo(() => computeRatings(s.records), [s.records]);
  const mine = ratingsFor(ratings, me);
  const theirs = opp ? ratingsFor(ratings, opp.id) : null;
  const h2h = opp ? headToHead(s.records, me, opp.id) : null;
  const recent = useMemo(
    () => [...s.records].filter((r) => r.white.id === me || r.black.id === me).sort((a, b) => b.endedAt - a.endedAt).slice(0, 6),
    [s.records, me],
  );

  return (
    <div className="home">
      <main className="home-main">
        <ConnectionCard />

        {connected && (
          <section className="card opponent-card">
            {others.length > 1 && (
              <select
                className="opponent-select"
                value={opp?.id}
                onChange={(e) => set({ opponentId: e.target.value })}
                aria-label="Opponent"
              >
                {others.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            {opp ? (
              <OpponentStatus opp={opp} />
            ) : (
              <FirstConnectHint />
            )}

            {outgoing ? (
              <div className="waiting">
                <div className="spinner" />
                <span>
                  {opp?.online
                    ? `Waiting for ${outgoing.to.name} to accept`
                    : `${outgoing.to.name} will see it when ChessLAN opens`}{" "}
                  · {formatTimeControl(outgoing.tc)}
                </span>
                <button className="btn" onClick={() => connection.send({ type: "challengeCancel", id: outgoing.id })}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="quick-play">
                <button
                  className="btn huge primary"
                  disabled={!canChallenge}
                  onClick={() => sendChallenge({ tc: ONE_MIN, color: "random", rated: true })}
                  data-testid="play-1"
                >
                  <span className="big">1 min</span>
                  <span className="sub">Bullet</span>
                </button>
                <button
                  className="btn huge primary"
                  disabled={!canChallenge}
                  onClick={() => sendChallenge({ tc: TEN_MIN, color: "random", rated: true })}
                  data-testid="play-10"
                >
                  <span className="big">10 min</span>
                  <span className="sub">Rapid</span>
                </button>
              </div>
            )}
            <button className="link" disabled={!canChallenge} onClick={() => setAdvanced(true)}>
              More options…
            </button>
          </section>
        )}

        <section className="card">
          <div className="card-head">
            <h3>Play the computer</h3>
            <button className="btn" onClick={() => setBotPicker(true)} data-testid="play-bot">
              Choose a bot
            </button>
          </div>
          <p className="muted small">Works even when nobody else is around. Not rated.</p>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Ratings</h3>
            <button className="link" onClick={() => navigate({ name: "stats" })}>
              Stats →
            </button>
          </div>
          <table className="ratings-table">
            <thead>
              <tr>
                <th />
                {RATED_CATEGORIES.map((c) => (
                  <th key={c}>{categoryLabel(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>You</td>
                {RATED_CATEGORIES.map((c) => (
                  <td key={c}>{mine[c].rating}</td>
                ))}
              </tr>
              {opp && theirs && (
                <tr>
                  <td>{opp.name}</td>
                  {RATED_CATEGORIES.map((c) => (
                    <td key={c}>{theirs[c].rating}</td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
          {opp && h2h && h2h.wins + h2h.losses + h2h.draws > 0 && (
            <p className="h2h">
              You vs {opp.name}: <b className="up">{h2h.wins}W</b> · <b className="down">{h2h.losses}L</b> · <b>{h2h.draws}D</b>
              {h2h.streak > 1 && <span className="streak"> 🔥 {h2h.streak} wins in a row</span>}
              {h2h.streak < -1 && <span className="streak"> {opp.name} has won {-h2h.streak} in a row</span>}
            </p>
          )}
        </section>

        {recent.length > 0 && (
          <section className="card">
            <div className="card-head">
              <h3>Recent games</h3>
              <button className="link" onClick={() => navigate({ name: "history" })}>
                All games →
              </button>
            </div>
            <ul className="recent">
              {recent.map((r) => {
                const outcome = recordOutcome(r, me);
                const other = r.white.id === me ? r.black : r.white;
                return (
                  <li key={r.id}>
                    <button className="recent-row" onClick={() => navigate({ name: "replay", id: r.id })}>
                      <span className={`badge ${outcome}`}>{outcome === "win" ? "W" : outcome === "loss" ? "L" : "D"}</span>
                      <span>vs {other.name}</span>
                      <span className="muted small">{reasonText(r.reason)}</span>
                      <span className="muted small">{formatTimeControl(r.tc)}</span>
                      <span className="muted small">{timeAgo(r.endedAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </main>

      <aside className="home-side card">
        <h3>Chat</h3>
        <Chat />
      </aside>

      {advanced && <AdvancedModal onClose={() => setAdvanced(false)} />}
      {botPicker && <BotPicker onClose={() => setBotPicker(false)} />}
    </div>
  );
}

function FirstConnectHint() {
  const [addresses, setAddresses] = useState<string[]>([]);
  useEffect(() => {
    if (isDesktop) void platform.getLocalAddresses().then(setAddresses);
  }, []);
  return (
    <p className="muted">
      Waiting for your opponent's app to turn up on this network for the first time…
      {addresses.length > 0 && (
        <>
          {" "}
          The apps find each other by themselves; if they don't, enter <b>{addresses.join(", ")}</b> in the other
          app's Settings.
        </>
      )}
    </p>
  );
}

function OpponentStatus({ opp }: { opp: PlayerPresence }) {
  const status = !opp.online
    ? { dot: "off", text: `${opp.name}'s app isn't running — a challenge will wait for it` }
    : opp.activity === "game"
      ? { dot: "busy", text: `${opp.name} is in a game` }
      : opp.activity === "bot"
        ? { dot: "on", text: `${opp.name} is playing the computer — you can still challenge` }
        : opp.windowOpen
          ? { dot: "on", text: `${opp.name} is here` }
          : { dot: "on", text: `${opp.name} is online — a challenge will pop up on their screen` };
  return (
    <div className="opponent-status">
      <span className={`dot ${status.dot}`} />
      <span>{status.text}</span>
    </div>
  );
}

function ConnectionCard() {
  const conn = useStore((s) => s.conn);
  const mismatch = useStore((s) => s.mismatch);
  const update = useStore((s) => s.update);

  if (conn === "connected") return null;
  if (conn === "mismatch") {
    return (
      <section className="card notice">
        <h3>Updating…</h3>
        <p>
          The other computer has ChessLAN {mismatch?.hubVersion}.{" "}
          {update.state === "downloading"
            ? `Downloading the matching version (${Math.round(update.progress ?? 0)}%)…`
            : update.state === "ready"
              ? "Update ready — restarting…"
              : "This app updates itself to match as soon as it can."}
        </p>
      </section>
    );
  }
  return (
    <section className="card notice">
      <div className="spinner" />
      <h3>Starting…</h3>
    </section>
  );
}

export function AdvancedModal({ onClose }: { onClose: () => void }) {
  const [tc, setTc] = useState<TimeControl | null>(ONE_MIN);
  const [custom, setCustom] = useState(false);
  const [minutes, setMinutes] = useState(5);
  const [increment, setIncrement] = useState(0);
  const [color, setColor] = useState<ColorChoice>("random");
  const [rated, setRated] = useState(true);
  const chosen: TimeControl | null = custom ? { initialMs: minutes * 60_000, incrementMs: increment * 1000 } : tc;
  const groups = ["Bullet", "Blitz", "Rapid"] as const;
  const same = (a: TimeControl | null, b: TimeControl | null) =>
    a === b || (!!a && !!b && a.initialMs === b.initialMs && a.incrementMs === b.incrementMs);

  return (
    <Modal onClose={onClose} className="advanced">
      <h2>New game</h2>
      {groups.map((g) => (
        <div key={g} className="tc-group">
          <h4>{g}</h4>
          <div className="tc-grid">
            {PRESETS.filter((p) => p.group === g).map((p) => (
              <button
                key={formatTimeControl(p.tc)}
                className={`btn tc ${!custom && same(tc, p.tc) ? "selected" : ""}`}
                onClick={() => {
                  setCustom(false);
                  setTc(p.tc);
                }}
              >
                {formatTimeControl(p.tc)}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="tc-group">
        <h4>Other</h4>
        <div className="tc-grid">
          <button className={`btn tc ${custom ? "selected" : ""}`} onClick={() => setCustom(true)}>
            Custom
          </button>
          <button
            className={`btn tc ${!custom && tc === null ? "selected" : ""}`}
            onClick={() => {
              setCustom(false);
              setTc(null);
            }}
          >
            No clock
          </button>
        </div>
        {custom && (
          <div className="custom-tc">
            <label>
              Minutes per side <b>{minutes}</b>
              <input type="range" min={1} max={120} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
            </label>
            <label>
              Seconds added per move <b>{increment}</b>
              <input type="range" min={0} max={60} value={increment} onChange={(e) => setIncrement(Number(e.target.value))} />
            </label>
          </div>
        )}
      </div>
      <div className="tc-group">
        <h4>Play as</h4>
        <div className="segmented">
          {(["white", "random", "black"] as ColorChoice[]).map((c) => (
            <button key={c} className={color === c ? "selected" : ""} onClick={() => setColor(c)}>
              {c === "white" ? "♔ White" : c === "black" ? "♚ Black" : "Random"}
            </button>
          ))}
        </div>
      </div>
      <Toggle label="Rated" hint={chosen ? undefined : "Games without a clock are never rated"} checked={rated && !!chosen} onChange={setRated} />
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          onClick={() => {
            sendChallenge({ tc: chosen, color, rated: rated && !!chosen });
            onClose();
          }}
        >
          Challenge {opponent()?.name ?? ""} · {formatTimeControl(chosen)}
        </button>
      </div>
    </Modal>
  );
}
