import { useEffect, useState } from "react";
import type { AppConfig } from "../../shared/bridge";
import { Toggle } from "../components/common";
import { connection } from "../net/connection";
import { isDesktop, platform } from "../platform";
import { sounds } from "../sound";
import { opponent, set, setPrefs, useStore, type Prefs } from "../state/store";
import { voice } from "../voice";

const PROMOTION_CHOICES: [Prefs["promotion"], string][] = [
  ["q", "♕ Queen"],
  ["n", "♘ Knight"],
  ["r", "♖ Rook"],
  ["b", "♗ Bishop"],
  ["ask", "Ask"],
];

export function Settings() {
  const config = useStore((s) => s.config);
  const prefs = useStore((s) => s.prefs);
  const update = useStore((s) => s.update);
  const hub = useStore((s) => s.hub);
  const conn = useStore((s) => s.conn);
  const [name, setName] = useState(config?.player?.name ?? "");
  const [address, setAddress] = useState(config?.peerAddress ?? "");
  const [myAddresses, setMyAddresses] = useState<string[]>([]);
  const opp = useStore((s) => opponent(s));
  useEffect(() => {
    if (isDesktop) void platform.getLocalAddresses().then(setMyAddresses);
  }, []);

  const saveConfig = async (patch: Partial<AppConfig>, reconnect = false) => {
    const next = await platform.setConfig(patch);
    set({ config: next });
    if (reconnect) connection.restart();
  };

  return (
    <div className="page settings">
      <h2>Settings</h2>

      <section className="card">
        <h3>You</h3>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (config?.player && name.trim()) void saveConfig({ player: { ...config.player, name: name.trim().slice(0, 30) } }, true);
          }}
        >
          <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          <button className="btn" type="submit" disabled={!name.trim() || name.trim() === config?.player?.name}>
            Save name
          </button>
        </form>
      </section>

      <section className="card">
        <h3>Board</h3>
        <Toggle label="Show legal moves" checked={prefs.showLegalMoves} onChange={(v) => setPrefs({ showLegalMoves: v })} />
        <Toggle label="Premoves" hint="Queue moves during your opponent's turn" checked={prefs.premoves} onChange={(v) => setPrefs({ premoves: v })} />
        <div className="field-row">
          <span>
            Promote pawns to
            <span className="hint">“Ask” shows a picker each time; premoves use your default or a queen</span>
          </span>
          <div className="segmented" role="radiogroup" aria-label="Promotion">
            {PROMOTION_CHOICES.map(([value, label]) => (
              <button
                key={value}
                role="radio"
                aria-checked={prefs.promotion === value}
                className={prefs.promotion === value ? "selected" : ""}
                onClick={() => setPrefs({ promotion: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <Toggle label="Coordinates" checked={prefs.coordinates} onChange={(v) => setPrefs({ coordinates: v })} />
        <Toggle label="Piece animation" checked={prefs.animations} onChange={(v) => setPrefs({ animations: v })} />
      </section>

      <section className="card">
        <h3>Sound & voice</h3>
        <Toggle label="Sounds" checked={prefs.sound} onChange={(v) => setPrefs({ sound: v })} />
        <label className="slider">
          <span>Volume</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={prefs.volume}
            onChange={(e) => setPrefs({ volume: Number(e.target.value) })}
            onPointerUp={() => sounds.move()}
          />
        </label>
        <Toggle
          label="Mute my microphone"
          hint="Voice chat is on while both of you have the app open"
          checked={prefs.micMuted}
          onChange={(v) => {
            setPrefs({ micMuted: v });
            voice.setMuted(v);
          }}
        />
      </section>

      {isDesktop && config && (
        <section className="card">
          <h3>This computer</h3>
          <Toggle label="Start ChessLAN when I log in" checked={config.startAtLogin} onChange={(v) => void saveConfig({ startAtLogin: v })} />
          <p className="muted small">
            {conn === "connected" && opp?.online
              ? `Linked with ${opp.name}'s app.`
              : "The other app isn't around right now."}{" "}
            The two apps find each other by themselves. This computer's address is{" "}
            <b>{myAddresses.join(", ") || "…"}</b>; only if they ever can't find each other, enter the other
            computer's address here:
          </p>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void saveConfig({ peerAddress: address.trim() || null });
            }}
          >
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Other computer's address (optional, e.g. 192.168.1.20)"
              aria-label="Other computer's address"
            />
            <button className="btn" type="submit">
              Save
            </button>
          </form>
        </section>
      )}

      <section className="card">
        <h3>About</h3>
        <p>
          ChessLAN {platform.appVersion}
          {hub?.version && hub.version !== platform.appVersion && <span className="muted"> · other app has {hub.version}</span>}
        </p>
        {isDesktop && (
          <p>
            {update.state === "ready" ? (
              <button className="btn primary" onClick={() => platform.installUpdate()}>
                Restart to update to {update.version}
              </button>
            ) : update.state === "downloading" ? (
              <span className="muted">Downloading {update.version}… {Math.round(update.progress ?? 0)}%</span>
            ) : (
              <button className="btn" onClick={() => platform.checkForUpdates()}>
                {update.state === "checking" ? "Checking…" : "Check for updates"}
              </button>
            )}
            {update.state === "error" && <span className="muted small"> {update.message}</span>}
          </p>
        )}
        <p className="muted small">
          Pieces:{" "}
          <button className="link" onClick={() => platform.openExternal("https://github.com/neverRare/kiwen-suwi")}>
            “Kiwen-suwi” by neverRare
          </button>
          , licensed{" "}
          <button className="link" onClick={() => platform.openExternal("https://creativecommons.org/licenses/by/4.0/")}>
            CC BY 4.0
          </button>
          .
        </p>
      </section>
    </div>
  );
}
