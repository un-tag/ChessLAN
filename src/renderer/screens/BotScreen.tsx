import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BotRequest, BotResponse } from "../../shared/bot/bot.worker";
import { getBot } from "../../shared/bot/bots";
import { Game, otherSide, type GameStatus, type Side } from "../../shared/chess/game";
import type { ColorChoice, GameRecord } from "../../shared/protocol";
import { animationMsFor, categoryOf, formatTimeControl, type TimeControl } from "../../shared/timeControl";
import { Board, type PremoveSpec } from "../board/Board";
import { ClockFace, MoveList, PlayerBar, captures, formatClock, lowTimeThreshold, useTicker } from "../components/common";
import { saveRecord } from "../net/connection";
import { moveSound, sounds } from "../sound";
import { navigate, useStore } from "../state/store";
import { startBotGame } from "./BotPicker";
import { reasonText, resultFor } from "./results";

let worker: Worker | null = null;
let nextRequest = 1;
const pending = new Map<number, (r: BotResponse) => void>();

function askBot(req: Omit<BotRequest, "id">): { id: number; result: Promise<BotResponse> } {
  if (!worker) {
    worker = new Worker(new URL("../../shared/bot/bot.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<BotResponse>) => {
      pending.get(e.data.id)?.(e.data);
      pending.delete(e.data.id);
    };
  }
  const id = nextRequest++;
  const result = new Promise<BotResponse>((resolve) => pending.set(id, resolve));
  worker.postMessage({ ...req, id } satisfies BotRequest);
  return { id, result };
}

const newId = (): string =>
  typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `bot-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function BotScreen({ botId, tc, color }: { botId: string; tc: TimeControl | null; color: ColorChoice }) {
  const bot = getBot(botId);
  const prefs = useStore((s) => s.prefs);
  const me = useStore((s) => s.config?.player);
  const [mySide] = useState<Side>(() => (color === "white" ? "w" : color === "black" ? "b" : Math.random() < 0.5 ? "w" : "b"));
  const botSide = otherSide(mySide);
  const gameRef = useRef(new Game());
  const game = gameRef.current;
  const [, setVersion] = useState(0);
  const rerender = () => setVersion((v) => v + 1);
  const [over, setOver] = useState<GameStatus | null>(null);
  const [thinking, setThinking] = useState(false);
  const [premoves, setPremoves] = useState<PremoveSpec[]>([]);
  const premovesRef = useRef(premoves);
  premovesRef.current = premoves;
  const [viewPly, setViewPly] = useState<number | null>(null);
  const [flipped, setFlipped] = useState(false);
  const activeRequest = useRef(0);
  const startedAt = useRef(Date.now());
  const saved = useRef(false);

  // Local clocks (same rules as hub games: they start after both first moves).
  const clock = useRef(tc ? { w: tc.initialMs, b: tc.initialMs, running: null as Side | null, since: 0 } : null);
  const left = (side: Side): number => {
    const c = clock.current;
    if (!c) return 0;
    return Math.max(0, c[side] - (c.running === side ? performance.now() - c.since : 0));
  };
  const switchClock = (mover: Side) => {
    const c = clock.current;
    if (!c || !tc) return;
    const now = performance.now();
    if (c.running === mover) c[mover] = Math.max(0, c[mover] - (now - c.since)) + tc.incrementMs;
    c.running = game.moves.length >= 2 ? otherSide(mover) : null;
    c.since = now;
  };
  const stopClock = () => {
    const c = clock.current;
    if (c?.running) {
      c[c.running] = left(c.running);
      c.running = null;
    }
  };

  const finish = useCallback(
    (status: GameStatus) => {
      stopClock();
      activeRequest.current = 0;
      setThinking(false);
      setPremoves([]);
      setOver(status);
      sounds.end();
      if (!saved.current && game.moves.length >= 2 && bot && me && status.result && status.reason) {
        saved.current = true;
        const botRef = { id: `bot:${bot.id}`, name: bot.name };
        const record: GameRecord = {
          id: newId(),
          white: mySide === "w" ? me : botRef,
          black: mySide === "b" ? me : botRef,
          tc,
          category: categoryOf(tc),
          rated: false,
          moves: game.uciMoves,
          result: status.result,
          reason: status.reason,
          startedAt: startedAt.current,
          endedAt: Date.now(),
          bot: { id: bot.id, name: bot.name, rating: bot.rating, side: botSide },
        };
        saveRecord(record);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bot, me, mySide, botSide, tc, game],
  );

  const afterMove = useCallback((): boolean => {
    const status = game.status();
    if (status.over) {
      finish(status);
      return false;
    }
    return true;
  }, [game, finish]);

  const requestBotMove = useCallback(() => {
    if (!bot || game.turn !== botSide) return;
    const level = bot.level;
    const remaining = tc ? left(botSide) : Infinity;
    const budget = Math.min(level.thinkMs, remaining / 30);
    const [lo, hi] = level.delayMs;
    const delay = Math.min(lo + Math.random() * (hi - lo), remaining / 40);
    const started = performance.now();
    const { id, result } = askBot({ fen: game.startFen, history: game.uciMoves, botId: bot.id, timeMs: Math.round(budget) });
    activeRequest.current = id;
    setThinking(true);
    void result.then((r) => {
      const wait = Math.max(0, started + delay - performance.now());
      setTimeout(() => {
        if (activeRequest.current !== id) return;
        activeRequest.current = 0;
        setThinking(false);
        const info = r.uci ? game.move(r.uci) : null;
        if (!info) return;
        moveSound(info);
        switchClock(botSide);
        setViewPly(null);
        rerender();
        if (afterMove()) runPremove();
      }, wait);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot, botSide, game, tc, afterMove]);

  const playMine = (from: string, to: string, promotion?: string): boolean => {
    if (over || game.turn !== mySide) return false;
    const info = game.move({ from, to, promotion });
    if (!info) return false;
    moveSound(info);
    switchClock(mySide);
    setViewPly(null);
    rerender();
    if (afterMove()) requestBotMove();
    return true;
  };

  function runPremove() {
    const [next, ...rest] = premovesRef.current;
    if (!next) return;
    if (game.legalDests().get(next.from)?.includes(next.to)) {
      setPremoves(rest);
      playMine(next.from, next.to, next.promotion ?? "q");
    } else {
      setPremoves([]);
    }
  }

  // The bot opens if it plays white.
  useEffect(() => {
    if (botSide === "w" && game.moves.length === 0) requestBotMove();
    return () => {
      activeRequest.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Flag check and low-time ticks.
  const running = clock.current?.running ?? null;
  useTicker(!!running && !over, 100);
  const myMs = left(mySide);
  const botMs = left(botSide);
  useEffect(() => {
    if (over || !running) return;
    if (left(running) <= 0) {
      activeRequest.current = 0;
      finish(game.timeoutResult(running));
    }
  });
  const lowAt = tc ? lowTimeThreshold(tc.initialMs) : 0;
  const lastTick = useRef<number | null>(null);
  useEffect(() => {
    if (running !== mySide || over || myMs > lowAt) {
      lastTick.current = null;
      return;
    }
    const sec = Math.ceil(myMs / 1000);
    if (lastTick.current !== null && lastTick.current !== sec) sounds.lowTime();
    lastTick.current = sec;
  });

  const takeback = () => {
    if (over) return;
    activeRequest.current = 0;
    setThinking(false);
    setPremoves([]);
    if (game.turn === botSide) game.undo();
    else {
      game.undo();
      game.undo();
    }
    if (clock.current) {
      stopClock();
      switchClock(otherSide(game.turn));
      if (game.moves.length < 2) clock.current.running = null;
    }
    setViewPly(null);
    rerender();
  };

  const total = game.moves.length;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cur = viewPly ?? total;
      if (e.key === "ArrowLeft") setViewPly(Math.max(0, cur - 1));
      else if (e.key === "ArrowRight") setViewPly(cur + 1 >= total ? null : cur + 1);
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
    [viewPly, total, game, over],
  );

  if (!bot) {
    navigate({ name: "home" });
    return null;
  }
  const live = shown === game;
  const myTurn = live && !over && game.turn === mySide;
  const last = shown.lastMove;
  const caps = captures(shown.moves);
  const orientation = flipped ? botSide : mySide;
  const outcome = over ? resultFor(over.result, mySide) : null;

  const myBar = (
    <PlayerBar
      name={me?.name ?? "You"}
      side={mySide}
      capturedPieces={caps[mySide]}
      lead={caps.lead[mySide]}
      clock={tc && <ClockFace ms={myMs} running={running === mySide} low={myMs <= lowAt} />}
    />
  );
  const botBar = (
    <PlayerBar
      name={`${bot.avatar} ${bot.name}`}
      rating={bot.rating}
      side={botSide}
      capturedPieces={caps[botSide]}
      lead={caps.lead[botSide]}
      badge={thinking ? <span className="thinking">thinking…</span> : undefined}
      clock={tc && <ClockFace ms={botMs} running={running === botSide} low={botMs <= lowAt} />}
    />
  );

  return (
    <div className="game-layout">
      <div className="board-column">
        {orientation === mySide ? botBar : myBar}
        <div className="board-wrap">
          <Board
            fen={shown.fen()}
            orientation={orientation}
            myColor={live && !over ? mySide : "none"}
            dests={myTurn ? game.legalDests() : new Map()}
            lastMove={last ? [last.from, last.to] : undefined}
            check={shown.inCheck() ? shown.kingSquare(shown.turn) : undefined}
            premoves={premoves}
            premoveEnabled={prefs.premoves && live && !over}
            onPremovesChange={(p) => {
              if (p.length > premoves.length) sounds.premove();
              setPremoves(p);
            }}
            onMove={(from, to, promotion) => {
              if (!playMine(from, to, promotion)) sounds.illegal();
            }}
            showLegalMoves={prefs.showLegalMoves}
            showCoordinates={prefs.coordinates}
            autoQueen={prefs.autoQueen}
            animationMs={prefs.animations ? animationMsFor(tc) : 0}
          />
          {over && (
            <div className="game-over" data-testid="game-over">
              <h2 className={outcome ?? ""}>{outcome === "win" ? "You won!" : outcome === "loss" ? `${bot.name} won` : "Draw"}</h2>
              <p className="muted">{reasonText(over.reason)}</p>
              <div className="game-over-actions">
                <button className="btn primary" onClick={() => startBotGame(bot.id, tc, color)}>
                  Play again
                </button>
                <button className="btn" onClick={() => navigate({ name: "home" })}>
                  Home
                </button>
              </div>
            </div>
          )}
        </div>
        {orientation === mySide ? myBar : botBar}
      </div>
      <aside className="side-panel">
        <div className="panel-head">
          <span>
            vs {bot.name} · {formatTimeControl(tc)}
            {tc && clock.current?.running === null && total < 2 && <span className="muted"> · clock starts after move 1</span>}
          </span>
          <button className="icon-btn" title="Flip board (F)" onClick={() => setFlipped((f) => !f)}>
            ⇅
          </button>
        </div>
        <p className="muted small bot-desc-line">{bot.description}</p>
        <MoveList moves={game.moves} current={viewPly ?? total} onSelect={(p) => setViewPly(p >= total ? null : p)} />
        <div className="controls">
          {!over ? (
            <>
              <button className="btn" onClick={takeback} disabled={!game.moves.some((m) => m.color === mySide)}>
                ↶ Takeback
              </button>
              <button className="btn" onClick={() => finish({ over: true, result: mySide === "w" ? "0-1" : "1-0", reason: "resign" })}>
                🏳 Resign
              </button>
            </>
          ) : (
            <button className="btn primary" onClick={() => startBotGame(bot.id, tc, color)}>
              New game
            </button>
          )}
        </div>
        {tc && over && <p className="muted small">Final clocks: you {formatClock(myMs)} · {bot.name} {formatClock(botMs)}</p>}
      </aside>
    </div>
  );
}
