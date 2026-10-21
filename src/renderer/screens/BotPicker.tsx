import { useState } from "react";
import { LEVEL_BOTS, PERSONALITIES, type BotConfig } from "../../shared/bot/bots";
import type { ColorChoice } from "../../shared/protocol";
import { formatTimeControl, type TimeControl } from "../../shared/timeControl";
import { Modal } from "../components/common";
import { navigate } from "../state/store";

const LAST_BOT_KEY = "chesslan.lastBot";

const CLOCKS: (TimeControl | null)[] = [
  null,
  { initialMs: 60_000, incrementMs: 0 },
  { initialMs: 180_000, incrementMs: 2000 },
  { initialMs: 300_000, incrementMs: 0 },
  { initialMs: 600_000, incrementMs: 0 },
];

function lastBot(): string {
  try {
    return localStorage.getItem(LAST_BOT_KEY) ?? LEVEL_BOTS[1].id;
  } catch {
    return LEVEL_BOTS[1].id;
  }
}

export function startBotGame(botId: string, tc: TimeControl | null, color: ColorChoice): void {
  try {
    localStorage.setItem(LAST_BOT_KEY, botId);
  } catch {
    // Only a convenience.
  }
  navigate({ name: "bot", botId, tc, color, key: Date.now() });
}

export function BotPicker({ onClose }: { onClose: () => void }) {
  const [botId, setBotId] = useState(lastBot);
  const [color, setColor] = useState<ColorChoice>("random");
  const [clock, setClock] = useState(0);
  const card = (b: BotConfig) => (
    <button
      key={b.id}
      className={`bot-card ${botId === b.id ? "selected" : ""}`}
      onClick={() => setBotId(b.id)}
      onDoubleClick={() => startBotGame(b.id, CLOCKS[clock], color)}
      data-testid={`bot-${b.id}`}
    >
      <span className="bot-avatar">{b.avatar}</span>
      <span className="bot-name">{b.name}</span>
      <span className="bot-rating">{b.rating}</span>
      {b.kind === "personality" && <span className="bot-desc">{b.description}</span>}
    </button>
  );
  return (
    <Modal onClose={onClose} className="bot-picker">
      <h2>Play the computer</h2>
      <h4>Characters</h4>
      <div className="bot-grid personalities">{PERSONALITIES.map(card)}</div>
      <h4>Levels</h4>
      <div className="bot-grid levels">{LEVEL_BOTS.map(card)}</div>
      <div className="picker-options">
        <div className="segmented">
          {(["white", "random", "black"] as ColorChoice[]).map((c) => (
            <button key={c} className={color === c ? "selected" : ""} onClick={() => setColor(c)}>
              {c === "white" ? "♔ White" : c === "black" ? "♚ Black" : "Random"}
            </button>
          ))}
        </div>
        <div className="segmented">
          {CLOCKS.map((tc, i) => (
            <button key={i} className={clock === i ? "selected" : ""} onClick={() => setClock(i)}>
              {tc ? formatTimeControl(tc) : "No clock"}
            </button>
          ))}
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => startBotGame(botId, CLOCKS[clock], color)} data-testid="start-bot">
          Play
        </button>
      </div>
    </Modal>
  );
}
