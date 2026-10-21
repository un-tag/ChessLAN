import { useState } from "react";
import type { Role } from "../../shared/bridge";
import { connection } from "../net/connection";
import { isDesktop, platform } from "../platform";
import { navigate, set } from "../state/store";

const newId = (): string =>
  typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function Setup() {
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>(platform.platform === "darwin" ? "host" : "join");
  const ready = name.trim().length > 0;

  const save = async () => {
    if (!ready) return;
    const config = await platform.setConfig({
      player: { id: newId(), name: name.trim().slice(0, 30) },
      role: isDesktop ? role : "join",
    });
    set({ config });
    navigate({ name: "home" });
    connection.start();
  };

  return (
    <div className="setup">
      <div className="setup-card card">
        <div className="logo-big">♞</div>
        <h1>Welcome to ChessLAN</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="field">
            <span>What's your name?</span>
            <input autoFocus value={name} maxLength={30} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
          </label>
          {isDesktop && (
            <fieldset className="roles">
              <legend>This computer…</legend>
              <label className={`role ${role === "host" ? "selected" : ""}`}>
                <input type="radio" name="role" checked={role === "host"} onChange={() => setRole("host")} />
                <b>Hosts the games</b>
                <span className="muted small">Pick this on the Mac. It keeps the history and ratings.</span>
              </label>
              <label className={`role ${role === "join" ? "selected" : ""}`}>
                <input type="radio" name="role" checked={role === "join"} onChange={() => setRole("join")} />
                <b>Joins the host</b>
                <span className="muted small">Pick this on the other computer. It finds the host on your Wi-Fi by itself.</span>
              </label>
            </fieldset>
          )}
          <button className="btn huge primary" type="submit" disabled={!ready}>
            Let's play
          </button>
        </form>
      </div>
    </div>
  );
}
