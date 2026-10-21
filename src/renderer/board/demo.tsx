// Standalone playground for the board: `npx vite src/renderer/board --port 5174`
// then open /demo.html. Not part of the app build (the app's root is
// src/renderer/index.html).
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Game } from "../../shared/chess";
import { Board, type Arrow, type PremoveSpec, type Side } from "./Board";

type Seat = Side | "both" | "none";

const DEMO_ARROWS: Arrow[] = [
  { from: "e2", to: "e4" },
  { from: "g1", to: "f3" },
  { from: "b8", to: "c6" },
  { from: "d4", to: "d4" },
];

declare global {
  interface Window {
    /** Hooks for ad-hoc browser tests. */
    __demo?: {
      fen: () => string;
      load: (fen: string) => void;
      premoves: () => PremoveSpec[];
      log: string[];
    };
  }
}

const log: string[] = [];

function Demo() {
  const gameRef = useRef(new Game());
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const [orientation, setOrientation] = useState<Side>("w");
  const [seat, setSeat] = useState<Seat>("both");
  const [simulate, setSimulate] = useState(false);
  const [premoves, setPremoves] = useState<PremoveSpec[]>([]);
  const [premoveEnabled, setPremoveEnabled] = useState(true);
  const [showLegalMoves, setShowLegalMoves] = useState(true);
  const [showCoordinates, setShowCoordinates] = useState(true);
  const [autoQueen, setAutoQueen] = useState(false);
  const [animationMs, setAnimationMs] = useState(120);
  const [controlledArrows, setControlledArrows] = useState(false);
  const [width, setWidth] = useState(560);
  const premovesRef = useRef(premoves);
  premovesRef.current = premoves;

  const g = gameRef.current;
  const fen = g.fen();
  const last = g.lastMove;
  const status = g.status();
  const myColor: Seat = status.over ? "none" : seat;

  useEffect(() => {
    window.__demo = {
      fen: () => gameRef.current.fen(),
      load: (f: string) => {
        gameRef.current = new Game(f);
        setPremoves([]);
        bump();
      },
      premoves: () => premovesRef.current,
      log,
    };
  }, []);

  // Simulated opponent: a random legal reply after 300 ms, then our first
  // premove is played the instant our turn begins (as the real app does).
  useEffect(() => {
    if (!simulate || (seat !== "w" && seat !== "b")) return;
    if (g.turn === seat || status.over) return;
    const t = setTimeout(() => {
      const game = gameRef.current;
      const all = [...game.legalDests()].flatMap(([from, tos]) => tos.map((to) => ({ from, to })));
      if (!all.length) return;
      const pick = all[Math.floor(Math.random() * all.length)];
      const info = game.move(game.isPromotion(pick.from, pick.to) ? { ...pick, promotion: "q" } : pick);
      log.push(`opponent ${info?.uci}`);
      const queue = premovesRef.current;
      if (queue.length && !game.status().over) {
        const [first, ...rest] = queue;
        const played = game.move(first);
        log.push(played ? `premove ${played.uci}` : `premove-failed ${first.from}${first.to}`);
        setPremoves(played ? rest : []);
      }
      bump();
    }, 300);
    return () => clearTimeout(t);
  });

  const onMove = (from: string, to: string, promotion?: string) => {
    const info = g.move({ from, to, promotion });
    log.push(info ? `move ${info.uci}` : `illegal ${from}${to}`);
    bump();
  };

  const onPremovesChange = (p: PremoveSpec[]) => {
    log.push(`premoves [${p.map((x) => x.from + x.to + (x.promotion ?? "")).join(",")}]`);
    setPremoves(p);
  };

  const newGame = () => {
    gameRef.current = new Game();
    setPremoves([]);
    log.push("new-game");
    bump();
  };

  const undo = () => {
    g.undo();
    setPremoves([]);
    log.push("undo");
    bump();
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
      <div style={{ width, maxWidth: "100%" }} id="board-wrap">
        <Board
          fen={fen}
          orientation={orientation}
          myColor={myColor}
          dests={g.legalDests()}
          lastMove={last ? [last.from, last.to] : undefined}
          check={g.inCheck() ? g.kingSquare(g.turn) : undefined}
          premoves={premoves}
          premoveEnabled={premoveEnabled}
          onPremovesChange={onPremovesChange}
          onMove={onMove}
          showLegalMoves={showLegalMoves}
          showCoordinates={showCoordinates}
          autoQueen={autoQueen}
          animationMs={animationMs}
          arrows={controlledArrows ? DEMO_ARROWS : undefined}
        />
      </div>
      <div className="panel">
        <div className="row">
          <button id="flip" onClick={() => setOrientation((o) => (o === "w" ? "b" : "w"))}>
            Flip board
          </button>
          <button id="new-game" onClick={newGame}>
            New game
          </button>
          <button id="undo" onClick={undo}>
            Undo
          </button>
        </div>
        <label>
          Play as{" "}
          <select id="seat" value={seat} onChange={(e) => setSeat(e.target.value as Seat)}>
            <option value="both">Both colours</option>
            <option value="w">White</option>
            <option value="b">Black</option>
            <option value="none">View only</option>
          </select>
        </label>
        <Check id="simulate" label="Simulate opponent (random reply after 300 ms)" value={simulate} set={setSimulate} />
        <Check id="premoves" label="Premoves" value={premoveEnabled} set={setPremoveEnabled} />
        <Check id="legal" label="Show legal moves" value={showLegalMoves} set={setShowLegalMoves} />
        <Check id="coords" label="Show coordinates" value={showCoordinates} set={setShowCoordinates} />
        <Check id="autoqueen" label="Auto-queen" value={autoQueen} set={setAutoQueen} />
        <Check id="arrows" label="Controlled arrows (replay style)" value={controlledArrows} set={setControlledArrows} />
        <label>
          Animation{" "}
          <select id="anim" value={animationMs} onChange={(e) => setAnimationMs(Number(e.target.value))}>
            {[0, 80, 120, 150, 400, 1000].map((ms) => (
              <option key={ms} value={ms}>
                {ms} ms
              </option>
            ))}
          </select>
        </label>
        <label>
          Size{" "}
          <input
            id="size"
            type="range"
            min={240}
            max={900}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
        </label>
        <div className="mono" id="fen">
          {fen}
        </div>
        <div className="mono" id="status">
          turn {g.turn}
          {status.over ? ` — ${status.result} ${status.reason}` : ""} · premoves [
          {premoves.map((p) => p.from + p.to).join(", ")}]
        </div>
      </div>
    </div>
  );
}

function Check(props: { id: string; label: string; value: boolean; set: (v: boolean) => void }) {
  return (
    <label>
      <input id={props.id} type="checkbox" checked={props.value} onChange={(e) => props.set(e.target.checked)} />{" "}
      {props.label}
    </label>
  );
}

const style = document.createElement("style");
style.textContent = `
  body { margin: 0; padding: 16px; background: #302e2b; color: #eee; font: 14px system-ui, sans-serif; }
  .panel { display: flex; flex-direction: column; gap: 8px; min-width: 260px; max-width: 360px; }
  .row { display: flex; gap: 8px; }
  button, select { font: inherit; }
  .mono { font: 12px ui-monospace, monospace; word-break: break-all; color: #bbb; }
`;
document.head.appendChild(style);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
