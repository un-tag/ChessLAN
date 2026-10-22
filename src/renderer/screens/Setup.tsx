import { useState } from "react";
import { connection } from "../net/connection";
import { platform } from "../platform";
import { navigate, set } from "../state/store";

const newId = (): string =>
  typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function Setup() {
  const [name, setName] = useState("");
  const ready = name.trim().length > 0;

  const save = async () => {
    if (!ready) return;
    const config = await platform.setConfig({ player: { id: newId(), name: name.trim().slice(0, 30) } });
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
          <p className="muted small">The other computer's ChessLAN finds this one on your Wi-Fi by itself.</p>
          <button className="btn huge primary" type="submit" disabled={!ready}>
            Let's play
          </button>
        </form>
      </div>
    </div>
  );
}
