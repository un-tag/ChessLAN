import { useEffect, useMemo, useState } from "react";
import { Game, toPgn, type Side } from "../../shared/chess/game";
import type { GameRecord } from "../../shared/protocol";
import { computeRatings } from "../../shared/ratings";
import { categoryLabel, formatTimeControl, pgnTimeControl } from "../../shared/timeControl";
import { Board } from "../board/Board";
import { MoveList, captures, PlayerBar } from "../components/common";
import { platform } from "../platform";
import { myId, navigate, toast, useStore } from "../state/store";
import { recordOutcome, reasonText } from "./results";

type Filter = "all" | "humans" | "bots";

export function History() {
  const records = useStore((s) => s.records);
  const me = myId();
  const [filter, setFilter] = useState<Filter>("all");
  const ratings = useMemo(() => computeRatings(records), [records]);
  const list = useMemo(
    () =>
      records
        .filter((r) => r.white.id === me || r.black.id === me)
        .filter((r) => (filter === "all" ? true : filter === "bots" ? !!r.bot : !r.bot))
        .sort((a, b) => b.endedAt - a.endedAt),
    [records, me, filter],
  );

  return (
    <div className="page">
      <div className="page-head">
        <h2>Game history</h2>
        <div className="segmented">
          {(["all", "humans", "bots"] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? "selected" : ""} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "humans" ? "Head to head" : "Computer"}
            </button>
          ))}
        </div>
      </div>
      {list.length === 0 ? (
        <p className="muted">No games yet.</p>
      ) : (
        <table className="history-table" data-testid="history">
          <thead>
            <tr>
              <th>Result</th>
              <th>Opponent</th>
              <th>How</th>
              <th>Time</th>
              <th>Moves</th>
              <th>Rating</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const side: Side = r.white.id === me ? "w" : "b";
              const other = side === "w" ? r.black : r.white;
              const outcome = recordOutcome(r, me);
              const change = ratings.changes.get(r.id);
              const delta = change ? change[side].after - change[side].before : null;
              return (
                <tr key={r.id} onClick={() => navigate({ name: "replay", id: r.id })}>
                  <td>
                    <span className={`badge ${outcome}`}>{outcome === "win" ? "Won" : outcome === "loss" ? "Lost" : "Draw"}</span>
                  </td>
                  <td>
                    {r.bot ? "🤖 " : ""}
                    {other.name} <span className="muted small">as {side === "w" ? "white" : "black"}</span>
                  </td>
                  <td className="muted">{reasonText(r.reason)}</td>
                  <td>{formatTimeControl(r.tc)}</td>
                  <td>{Math.ceil(r.moves.length / 2)}</td>
                  <td>
                    {delta === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className={delta >= 0 ? "up" : "down"}>
                        {delta >= 0 ? "+" : ""}
                        {delta}
                      </span>
                    )}
                  </td>
                  <td className="muted">{new Date(r.endedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function recordPgn(r: GameRecord, game: Game): string {
  return toPgn(game.moves, {
    white: r.white.name,
    black: r.black.name,
    result: r.result,
    date: new Date(r.startedAt),
    timeControl: pgnTimeControl(r.tc),
    termination: reasonText(r.reason),
    event: r.bot ? "ChessLAN vs computer" : r.rated ? `ChessLAN rated ${r.category}` : "ChessLAN casual",
  });
}

export function Replay({ id }: { id: string }) {
  const record = useStore((s) => s.records.find((r) => r.id === id));
  const me = myId();
  const full = useMemo(() => (record ? Game.fromUci(record.moves) : null), [record]);
  const total = full?.moves.length ?? 0;
  const [ply, setPly] = useState(total);
  const [flipped, setFlipped] = useState(false);
  useEffect(() => setPly(total), [total]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setPly((p) => Math.max(0, p - 1));
      else if (e.key === "ArrowRight") setPly((p) => Math.min(total, p + 1));
      else if (e.key === "ArrowUp" || e.key === "Home") setPly(0);
      else if (e.key === "ArrowDown" || e.key === "End") setPly(total);
      else if (e.key === "f") setFlipped((f) => !f);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [total]);

  const shown = useMemo(() => (record ? Game.fromUci(record.moves.slice(0, ply)) : null), [record, ply]);
  if (!record || !full || !shown) {
    return (
      <div className="page">
        <p className="muted">That game isn't in your history.</p>
        <button className="btn" onClick={() => navigate({ name: "history" })}>
          Back
        </button>
      </div>
    );
  }
  const mySide: Side = record.black.id === me ? "b" : "w";
  const orientation: Side = flipped ? (mySide === "w" ? "b" : "w") : mySide;
  const last = shown.lastMove;
  const caps = captures(shown.moves);
  const pgn = recordPgn(record, full);
  const outcome = recordOutcome(record, me);
  const bar = (side: Side) => {
    const p = side === "w" ? record.white : record.black;
    return <PlayerBar name={p.name} side={side} capturedPieces={caps[side]} lead={caps.lead[side]} />;
  };

  return (
    <div className="game-layout">
      <div className="board-column">
        {bar(orientation === "w" ? "b" : "w")}
        <div className="board-wrap">
          <Board
            fen={shown.fen()}
            orientation={orientation}
            myColor="none"
            dests={new Map()}
            lastMove={last ? [last.from, last.to] : undefined}
            check={shown.inCheck() ? shown.kingSquare(shown.turn) : undefined}
            premoves={[]}
            premoveEnabled={false}
            showLegalMoves={false}
            showCoordinates={useStore.getState().prefs.coordinates}
            autoQueen
            animationMs={150}
          />
        </div>
        {bar(orientation)}
      </div>
      <aside className="side-panel">
        <div className="panel-head">
          <span>
            {formatTimeControl(record.tc)} · {record.bot ? "vs computer" : record.rated ? `Rated ${categoryLabel(record.category)}` : "Casual"}
          </span>
          <button className="icon-btn" title="Flip board (F)" onClick={() => setFlipped((f) => !f)}>
            ⇅
          </button>
        </div>
        <p className={`replay-result ${outcome}`}>
          {record.result} · {outcome === "win" ? "You won" : outcome === "loss" ? "You lost" : "Draw"} {reasonText(record.reason)}
        </p>
        <MoveList moves={full.moves} current={ply} onSelect={setPly} />
        <div className="controls nav">
          <button className="btn" onClick={() => setPly(0)} aria-label="First move">
            ⏮
          </button>
          <button className="btn" onClick={() => setPly((p) => Math.max(0, p - 1))} aria-label="Previous move">
            ◀
          </button>
          <button className="btn" onClick={() => setPly((p) => Math.min(total, p + 1))} aria-label="Next move">
            ▶
          </button>
          <button className="btn" onClick={() => setPly(total)} aria-label="Last move">
            ⏭
          </button>
        </div>
        <div className="controls">
          <button
            className="btn"
            onClick={() =>
              navigator.clipboard.writeText(pgn).then(
                () => toast("PGN copied"),
                () => toast("Couldn't copy", "error"),
              )
            }
          >
            Copy PGN
          </button>
          <button
            className="btn"
            onClick={() =>
              void platform.savePgn(
                `${record.white.name}-vs-${record.black.name}-${new Date(record.startedAt).toISOString().slice(0, 10)}.pgn`,
                pgn,
              )
            }
          >
            Save .pgn
          </button>
        </div>
        <button className="link" onClick={() => navigate({ name: "history" })}>
          ← All games
        </button>
      </aside>
    </div>
  );
}
