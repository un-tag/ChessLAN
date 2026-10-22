import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Game, otherSide, type MoveInfo, type Side } from "../../shared/chess/game";
import type { GameView } from "../../shared/protocol";
import { computeRatings, ratingsFor } from "../../shared/ratings";
import { ONE_MIN, TEN_MIN, animationMsFor, categoryLabel, categoryOf, formatTimeControl } from "../../shared/timeControl";
import { Board, type PremoveSpec } from "../board/Board";
import { Chat } from "../components/Chat";
import {
  ClockFace,
  MoveList,
  PlayerBar,
  captures,
  lowTimeThreshold,
  remainingMs,
  useTicker,
} from "../components/common";
import { connection } from "../net/connection";
import { platform } from "../platform";
import { moveSound, sounds } from "../sound";
import { myId, navigate, serverNow, useStore } from "../state/store";
import { AdvancedModal, challengeStatus, sendChallenge } from "./Home";
import { reasonText, resultFor } from "./results";

export function GameScreen() {
  const view = useStore((s) => s.game);
  useEffect(() => {
    if (!view) navigate({ name: "home" });
  }, [view]);
  return view ? <LiveGame key={view.id} view={view} /> : null;
}

function LiveGame({ view }: { view: GameView }) {
  const me = myId();
  const mySide: Side = view.white.id === me ? "w" : "b";
  const oppSide = otherSide(mySide);
  const opp = mySide === "w" ? view.black : view.white;
  const prefs = useStore((s) => s.prefs);
  const records = useStore((s) => s.records);
  const remoteTalking = useStore((s) => s.remoteTalking);

  // Local copy of the game: hub moves plus our not-yet-confirmed move.
  const gameRef = useRef(new Game());
  const [, setVersion] = useState(0);
  const rerender = () => setVersion((v) => v + 1);
  const game = gameRef.current;

  const [premoves, setPremoves] = useState<PremoveSpec[]>([]);
  const premovesRef = useRef(premoves);
  premovesRef.current = premoves;
  const [viewPly, setViewPly] = useState<number | null>(null); // null = live
  const [flipped, setFlipped] = useState(false);
  const [confirmResign, setConfirmResign] = useState(false);
  const turnStart = useRef(performance.now());
  const frozenAt = useRef<number | null>(null);
  // Our move that the hub hasn't confirmed yet (shown optimistically).
  const pending = useRef<string | null>(null);

  const sendMove = useCallback(
    (info: MoveInfo, thinkMs: number) => {
      frozenAt.current = serverNow();
      pending.current = info.uci;
      const sent = connection.send({ type: "move", gameId: view.id, uci: info.uci, ply: game.moves.length - 1, thinkMs: Math.round(thinkMs) });
      if (!sent) {
        game.undo();
        frozenAt.current = null;
        pending.current = null;
        rerender();
      }
    },
    [view.id, game],
  );

  const playMine = useCallback(
    (from: string, to: string, promotion?: string, thinkMs?: number) => {
      const info = game.move({ from, to, promotion });
      if (!info) return false;
      moveSound(info);
      sendMove(info, thinkMs ?? performance.now() - turnStart.current);
      setViewPly(null);
      rerender();
      return true;
    },
    [game, sendMove],
  );

  // Submits the first queued premove the instant our turn begins.
  const tryPremove = useCallback(() => {
    const queue = premovesRef.current;
    if (!queue.length || game.turn !== mySide || game.status().over) return;
    const [next, ...rest] = queue;
    const dests = game.legalDests().get(next.from);
    if (dests?.includes(next.to)) {
      const promotion = game.isPromotion(next.from, next.to) ? (next.promotion ?? "q") : undefined;
      playMine(next.from, next.to, promotion, 0);
      setPremoves(rest);
    } else {
      setPremoves([]);
    }
  }, [game, mySide, playMine]);

  // Reconcile with every hub snapshot.
  useEffect(() => {
    const hub = view.moves;
    const local = game.uciMoves;
    const isPrefix = (a: string[], b: string[]) => a.length <= b.length && a.every((m, i) => m === b[i]);
    const waitingForEcho =
      pending.current !== null && local.length === hub.length + 1 && local[local.length - 1] === pending.current && isPrefix(hub, local);
    if (waitingForEcho) {
      // Our move is still on its way to the hub; keep showing it.
    } else if (isPrefix(local, hub)) {
      pending.current = null;
      frozenAt.current = null;
      const fresh = hub.slice(local.length);
      for (const uci of fresh) {
        const info = game.move(uci);
        if (info && info.color !== mySide) {
          moveSound(info);
          turnStart.current = performance.now();
        }
      }
      if (fresh.length) {
        setViewPly(null);
        tryPremove();
      }
    } else {
      // Diverged (takeback or a rejected move): adopt the hub's version.
      pending.current = null;
      frozenAt.current = null;
      gameRef.current = Game.fromUci(hub);
      turnStart.current = performance.now();
      setPremoves([]);
      setViewPly(null);
    }
    rerender();
  }, [view, game, mySide, tryPremove]);

  // The hub rejected something: stop waiting for our move's echo.
  useEffect(
    () =>
      connection.on((msg) => {
        if (msg.type === "error") pending.current = null;
      }),
    [],
  );

  // Game over: sound once, tell main (updates wait until no game is on).
  const wasOver = useRef(view.over);
  useEffect(() => {
    platform.setInGame(!view.over);
    if (view.over && !wasOver.current) {
      sounds.end();
      setPremoves([]);
    }
    wasOver.current = view.over;
  }, [view.over]);
  useEffect(() => () => platform.setInGame(false), []);

  // Clocks.
  const clock = view.clock;
  const ticking = !!clock?.running && !view.over;
  useTicker(ticking, 100);
  const myMs = clock ? remainingMs(clock, mySide, frozenAt.current) : 0;
  const oppMs = clock ? remainingMs(clock, oppSide, frozenAt.current) : 0;
  const lowAt = view.tc ? lowTimeThreshold(view.tc.initialMs) : 0;
  const lastTickSec = useRef<number | null>(null);
  useEffect(() => {
    if (!clock || clock.running !== mySide || view.over || myMs > lowAt) {
      lastTickSec.current = null;
      return;
    }
    const sec = Math.ceil(myMs / 1000);
    if (lastTickSec.current !== sec) {
      if (lastTickSec.current !== null) sounds.lowTime();
      lastTickSec.current = sec;
    }
  });

  // Keyboard: browse moves with arrows.
  const total = game.moves.length;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const cur = viewPly ?? total;
      if (e.key === "ArrowLeft") setViewPly(Math.max(0, cur - 1));
      else if (e.key === "ArrowRight") setViewPly(cur + 1 >= total ? null : cur + 1);
      else if (e.key === "ArrowUp" || e.key === "Home") setViewPly(0);
      else if (e.key === "ArrowDown" || e.key === "End") setViewPly(null);
      else if (e.key === "f") setFlipped((f) => !f);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewPly, total]);

  const shown = useMemo(
    () => (viewPly === null || viewPly >= total ? game : Game.fromUci(game.uciMoves.slice(0, viewPly))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewPly, total, game],
  );
  const live = shown === game;
  const myTurn = live && !view.over && game.turn === mySide;
  const last = shown.lastMove;
  const caps = captures(shown.moves);

  const ratings = useMemo(() => computeRatings(records.filter((r) => r.id !== view.id)), [records, view.id]);
  const category = categoryOf(view.tc);
  const ratingOf = (id: string) =>
    category === "untimed" ? undefined : ratingsFor(ratings, id)[category].rating;

  const orientation = flipped ? oppSide : mySide;
  const top = orientation === mySide ? "opp" : "me";

  const send = connection.send.bind(connection);
  const oppName = opp.name;

  const myBar = (
    <PlayerBar
      name={`${useStore.getState().config?.player?.name ?? "You"}`}
      rating={ratingOf(me)}
      side={mySide}
      capturedPieces={caps[mySide]}
      lead={caps.lead[mySide]}
      clock={clock && <ClockFace ms={myMs} running={clock.running === mySide && !view.over} low={myMs <= lowAt} />}
    />
  );
  const oppBar = (
    <PlayerBar
      name={oppName}
      rating={ratingOf(opp.id)}
      side={oppSide}
      capturedPieces={caps[oppSide]}
      lead={caps.lead[oppSide]}
      talking={remoteTalking}
      clock={clock && <ClockFace ms={oppMs} running={clock.running === oppSide && !view.over} low={oppMs <= lowAt} />}
    />
  );

  return (
    <div className="game-layout">
      <div className="board-column">
        {top === "opp" ? oppBar : myBar}
        <div className="board-wrap">
          <Board
            fen={shown.fen()}
            orientation={orientation}
            myColor={live && !view.over ? mySide : "none"}
            dests={myTurn ? game.legalDests() : new Map()}
            lastMove={last ? [last.from, last.to] : undefined}
            check={shown.inCheck() ? shown.kingSquare(shown.turn) : undefined}
            premoves={premoves}
            premoveEnabled={prefs.premoves && live && !view.over}
            onPremovesChange={(p) => {
              if (p.length > premoves.length) sounds.premove();
              setPremoves(p);
            }}
            onMove={(from, to, promotion) => {
              if (!playMine(from, to, promotion)) sounds.illegal();
            }}
            showLegalMoves={prefs.showLegalMoves}
            showCoordinates={prefs.coordinates}
            autoPromote={prefs.promotion === "ask" ? null : prefs.promotion}
            animationMs={prefs.animations ? animationMsFor(view.tc) : 0}
          />
          {view.over && <GameOver view={view} mySide={mySide} oppName={oppName} />}
        </div>
        {top === "opp" ? myBar : oppBar}
      </div>

      <aside className="side-panel">
        <div className="panel-head">
          <span>
            {formatTimeControl(view.tc)} · {view.rated ? `Rated ${categoryLabel(category)}` : "Casual"}
          </span>
          <button className="icon-btn" title="Flip board (F)" onClick={() => setFlipped((f) => !f)}>
            ⇅
          </button>
        </div>
        <MoveList moves={game.moves} current={viewPly ?? total} onSelect={(p) => setViewPly(p >= total ? null : p)} />

        <Banners view={view} mySide={mySide} oppName={oppName} />

        {!view.over && (
          <div className="controls">
            {game.moves.length < 2 ? (
              <button className="btn" onClick={() => send({ type: "abort", gameId: view.id })}>
                Abort
              </button>
            ) : confirmResign ? (
              <>
                <button
                  className="btn danger"
                  onClick={() => {
                    send({ type: "resign", gameId: view.id });
                    setConfirmResign(false);
                  }}
                >
                  Yes, resign
                </button>
                <button className="btn" onClick={() => setConfirmResign(false)}>
                  Keep playing
                </button>
              </>
            ) : (
              <>
                <button className="btn" title="Resign" onClick={() => setConfirmResign(true)}>
                  🏳 Resign
                </button>
                <button
                  className="btn"
                  title="Offer a draw"
                  disabled={view.drawOffer === mySide}
                  onClick={() => send({ type: "drawOffer", gameId: view.id })}
                >
                  ½ Draw
                </button>
                <button
                  className="btn"
                  title="Ask to take back your last move"
                  disabled={view.takeback === mySide || !game.moves.some((m) => m.color === mySide)}
                  onClick={() => send({ type: "takebackRequest", gameId: view.id })}
                >
                  ↶ Takeback
                </button>
              </>
            )}
          </div>
        )}
        <Chat compact />
      </aside>
    </div>
  );
}

function Banners({ view, mySide, oppName }: { view: GameView; mySide: Side; oppName: string }) {
  const send = connection.send.bind(connection);
  const opp = otherSide(mySide);
  useTicker(!!view.disconnected, 1000);
  const banners = [];
  if (view.drawOffer === opp) {
    banners.push(
      <div className="banner" key="draw">
        <span>{oppName} offers a draw</span>
        <button className="btn small primary" onClick={() => send({ type: "drawRespond", gameId: view.id, accept: true })}>
          Accept
        </button>
        <button className="btn small" onClick={() => send({ type: "drawRespond", gameId: view.id, accept: false })}>
          Decline
        </button>
      </div>,
    );
  } else if (view.drawOffer === mySide) {
    banners.push(<div className="banner muted" key="draw">Draw offer sent</div>);
  }
  if (view.takeback === opp) {
    banners.push(
      <div className="banner" key="tb">
        <span>{oppName} asks to take back</span>
        <button className="btn small primary" onClick={() => send({ type: "takebackRespond", gameId: view.id, accept: true })}>
          Accept
        </button>
        <button className="btn small" onClick={() => send({ type: "takebackRespond", gameId: view.id, accept: false })}>
          Decline
        </button>
      </div>,
    );
  } else if (view.takeback === mySide) {
    banners.push(<div className="banner muted" key="tb">Takeback request sent</div>);
  }
  if (view.disconnected && view.disconnected.side === opp) {
    const secs = Math.max(0, Math.ceil((view.disconnected.deadline - serverNow()) / 1000));
    banners.push(
      <div className="banner warn" key="dc">
        {oppName} disconnected — {view.moves.length < 2 ? "game aborts" : "you win"} in {secs}s unless they come back
      </div>,
    );
  }
  return <>{banners}</>;
}

function GameOver({ view, mySide, oppName }: { view: GameView; mySide: Side; oppName: string }) {
  const [hidden, setHidden] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const outgoing = useStore((s) => s.challenges.find((c) => c.from.id === myId()));
  const players = useStore((s) => s.players);
  const send = connection.send.bind(connection);
  const outcome = resultFor(view.result, mySide);
  const change = view.ratingChange?.[mySide];
  const opp = otherSide(mySide);
  if (hidden) {
    return (
      <button className="btn reopen-result" onClick={() => setHidden(false)}>
        Show result
      </button>
    );
  }
  return (
    <>
      <div className="game-over" data-testid="game-over">
        <button className="close" onClick={() => setHidden(true)} aria-label="Close">
          ✕
        </button>
        <h2 className={outcome}>
          {view.reason === "aborted" ? "Game aborted" : outcome === "win" ? "You won!" : outcome === "loss" ? `${oppName} won` : "Draw"}
        </h2>
        {view.reason !== "aborted" && <p className="muted">{reasonText(view.reason)}</p>}
        {change && (
          <p className="rating-change">
            {categoryLabel(view.ratingChange!.category)} {change.after}{" "}
            <span className={change.after >= change.before ? "up" : "down"}>
              {change.after >= change.before ? "+" : ""}
              {change.after - change.before}
            </span>
          </p>
        )}
        <div className="game-over-actions">
          {view.rematch.includes(mySide) ? (
            <button className="btn" disabled>
              Waiting for {oppName}…
            </button>
          ) : (
            <button className="btn primary" onClick={() => send({ type: "rematch", gameId: view.id })}>
              {view.rematch.includes(opp) ? `${oppName} wants a rematch — Accept` : "Rematch"}
            </button>
          )}
          {outgoing ? (
            <div className="row waiting-inline">
              <span className="muted small" data-testid="challenge-status">
                {challengeStatus(outgoing, players)} · {formatTimeControl(outgoing.tc)}
              </span>
              <button className="btn small" onClick={() => send({ type: "challengeCancel", id: outgoing.id })}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="row">
              <button className="btn" onClick={() => sendChallenge({ tc: ONE_MIN, color: "random", rated: true })}>
                1 min
              </button>
              <button className="btn" onClick={() => sendChallenge({ tc: TEN_MIN, color: "random", rated: true })}>
                10 min
              </button>
              <button className="btn" onClick={() => setAdvanced(true)}>
                More…
              </button>
            </div>
          )}
          <div className="row">
            {view.reason !== "aborted" && (
              <button className="btn" onClick={() => navigate({ name: "replay", id: view.id })}>
                Review
              </button>
            )}
            <button className="btn" onClick={() => navigate({ name: "home" })}>
              Home
            </button>
          </div>
        </div>
      </div>
      {/* Outside the card: its transform would trap a fixed-position modal. */}
      {advanced && <AdvancedModal onClose={() => setAdvanced(false)} />}
    </>
  );
}
