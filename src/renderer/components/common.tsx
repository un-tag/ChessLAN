import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MoveInfo, PieceSymbol, Side } from "../../shared/chess/game";
import type { ClockView } from "../../shared/protocol";
import { serverNow } from "../state/store";
import { pieceImage } from "./pieces";

/** Re-renders every `ms` while `active`. */
export function useTicker(active: boolean, ms = 100): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return tick;
}

/** Remaining ms for `side` right now, given a hub clock snapshot. */
export function remainingMs(clock: ClockView, side: Side, frozenAt?: number | null): number {
  if (clock.running !== side) return clock[side];
  const now = frozenAt ?? serverNow();
  return Math.max(0, clock[side] - Math.max(0, now - clock.at));
}

export function formatClock(ms: number): string {
  const t = Math.max(0, ms);
  const totalSec = Math.floor(t / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (t < 20_000) return `${m}:${String(s).padStart(2, "0")}.${Math.floor((t % 1000) / 100)}`;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function lowTimeThreshold(initialMs: number): number {
  return Math.max(10_000, Math.min(30_000, initialMs * 0.1));
}

export function ClockFace({ ms, running, low }: { ms: number; running: boolean; low: boolean }) {
  return (
    <div className={`clock ${running ? "running" : ""} ${low ? "low" : ""}`} data-testid="clock">
      {formatClock(ms)}
    </div>
  );
}

const ORDER: PieceSymbol[] = ["q", "r", "b", "n", "p"];
const VALUE: Record<PieceSymbol, number> = { q: 9, r: 5, b: 3, n: 3, p: 1, k: 0 };

/** Pieces each side has captured, plus the material lead. */
export function captures(moves: readonly MoveInfo[]): { w: PieceSymbol[]; b: PieceSymbol[]; lead: { w: number; b: number } } {
  const w: PieceSymbol[] = [];
  const b: PieceSymbol[] = [];
  let diff = 0;
  for (const m of moves) {
    if (m.captured) {
      (m.color === "w" ? w : b).push(m.captured);
      diff += (m.color === "w" ? 1 : -1) * VALUE[m.captured];
    }
    if (m.promotion) diff += (m.color === "w" ? 1 : -1) * (VALUE[m.promotion] - 1);
  }
  const sort = (l: PieceSymbol[]) => l.sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y));
  return { w: sort(w), b: sort(b), lead: { w: Math.max(0, diff), b: Math.max(0, -diff) } };
}

export function Captured({ pieces, color, lead }: { pieces: PieceSymbol[]; color: Side; lead: number }) {
  return (
    <div className="captured">
      {pieces.map((p, i) => (
        <img key={i} src={pieceImage(color, p)} alt={p} />
      ))}
      {lead > 0 && <span className="lead">+{lead}</span>}
    </div>
  );
}

export function PlayerBar(props: {
  name: string;
  rating?: number | string;
  side: Side;
  capturedPieces: PieceSymbol[];
  lead: number;
  clock?: ReactNode;
  badge?: ReactNode;
  talking?: boolean;
}) {
  return (
    <div className="player-bar">
      <div className={`avatar ${props.side === "w" ? "light" : "dark"} ${props.talking ? "talking" : ""}`}>
        {props.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="player-info">
        <div className="player-name">
          {props.name} {props.rating !== undefined && <span className="rating">({props.rating})</span>}
          {props.badge}
        </div>
        <Captured pieces={props.capturedPieces} color={props.side === "w" ? "b" : "w"} lead={props.lead} />
      </div>
      {props.clock}
    </div>
  );
}

export function MoveList({
  moves,
  current,
  onSelect,
}: {
  moves: readonly MoveInfo[];
  current: number; // ply shown on the board (moves.length = live)
  onSelect: (ply: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector(".move.current");
    el?.scrollIntoView({ block: "nearest" });
  }, [current, moves.length]);
  const rows: { n: number; w?: MoveInfo; b?: MoveInfo }[] = [];
  moves.forEach((m, i) => {
    if (i % 2 === 0) rows.push({ n: i / 2 + 1, w: m });
    else rows[rows.length - 1].b = m;
  });
  return (
    <div className="move-list" ref={ref} data-testid="move-list">
      {rows.length === 0 && <div className="muted small">No moves yet</div>}
      {rows.map((r, i) => (
        <div className="move-row" key={r.n}>
          <span className="move-no">{r.n}.</span>
          {[r.w, r.b].map((m, j) =>
            m ? (
              <button
                key={j}
                className={`move ${current === i * 2 + j + 1 ? "current" : ""}`}
                onClick={() => onSelect(i * 2 + j + 1)}
              >
                {m.san}
              </button>
            ) : (
              <span key={j} />
            ),
          )}
        </div>
      ))}
    </div>
  );
}

export function Modal({ children, onClose, className }: { children: ReactNode; onClose?: () => void; className?: string }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${className ?? ""}`} role="dialog">
        {children}
      </div>
    </div>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="toggle">
      <span>
        {label}
        {hint && <span className="hint">{hint}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" />
    </label>
  );
}

export function timeAgo(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = new Date(at);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
