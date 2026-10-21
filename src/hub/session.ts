// One live game on the hub: rules, authoritative clocks, draw/takeback/
// rematch negotiation and disconnect handling. Time is injected so tests can
// drive it deterministically.
import { Game, otherSide, type EndReason, type Result, type Side } from "../shared/chess/game";
import { ABANDON_MS, type GameView, type PlayerRef, type RatingChange } from "../shared/protocol";
import type { TimeControl } from "../shared/timeControl";

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface SessionOptions {
  id: string;
  white: PlayerRef;
  black: PlayerRef;
  tc: TimeControl | null;
  rated: boolean;
  clock: Clock;
  /** Extra time allowed before flagging a side, to absorb network latency. */
  flagGraceMs?: (side: Side) => number;
  onChange: (view: GameView) => void;
  onFinish: (session: GameSession) => void;
}

export type ActionResult = { ok: true } | { ok: false; error: string };
const fail = (error: string): ActionResult => ({ ok: false, error });
const OK: ActionResult = { ok: true };

export class GameSession {
  readonly id: string;
  readonly white: PlayerRef;
  readonly black: PlayerRef;
  readonly tc: TimeControl | null;
  readonly rated: boolean;
  readonly startedAt: number;
  readonly game = new Game();

  over = false;
  result?: Result;
  reason?: EndReason | "aborted";
  endedAt?: number;
  ratingChange?: RatingChange;
  nextGameId?: string;

  private remaining = { w: 0, b: 0 };
  private running: Side | null = null;
  private turnStart = 0;
  private drawOffer: Side | null = null;
  private takeback: Side | null = null;
  private rematch = new Set<Side>();
  private gone: Partial<Record<Side, number>> = {};
  private flagTimer: unknown = null;
  private abandonTimer: unknown = null;

  constructor(private opts: SessionOptions) {
    this.id = opts.id;
    this.white = opts.white;
    this.black = opts.black;
    this.tc = opts.tc;
    this.rated = opts.rated;
    this.startedAt = opts.clock.now();
    if (opts.tc) this.remaining = { w: opts.tc.initialMs, b: opts.tc.initialMs };
  }

  sideOf(playerId: string): Side | null {
    if (playerId === this.white.id) return "w";
    if (playerId === this.black.id) return "b";
    return null;
  }

  get ply(): number {
    return this.game.moves.length;
  }

  /** Abort is possible until both players have made a move. */
  get abortable(): boolean {
    return !this.over && this.ply < 2;
  }

  private now(): number {
    return this.opts.clock.now();
  }

  view(): GameView {
    const disconnected = (["w", "b"] as Side[])
      .filter((s) => this.gone[s] !== undefined)
      .map((s) => ({ side: s, deadline: this.gone[s]! + ABANDON_MS }))
      .sort((a, b) => a.deadline - b.deadline)[0];
    return {
      id: this.id,
      white: this.white,
      black: this.black,
      tc: this.tc,
      rated: this.rated,
      moves: this.game.uciMoves,
      clock: this.tc ? { ...this.liveRemaining(), running: this.running, at: this.now() } : null,
      over: this.over,
      result: this.result,
      reason: this.reason,
      drawOffer: this.drawOffer,
      takeback: this.takeback,
      rematch: [...this.rematch],
      disconnected: this.over ? null : (disconnected ?? null),
      startedAt: this.startedAt,
      ratingChange: this.ratingChange,
      nextGameId: this.nextGameId,
    };
  }

  private liveRemaining(): { w: number; b: number } {
    const r = { ...this.remaining };
    if (this.running) r[this.running] = Math.max(0, r[this.running] - (this.now() - this.turnStart));
    return r;
  }

  private changed(): void {
    this.opts.onChange(this.view());
  }

  move(playerId: string, uci: string, ply: number, thinkMs?: number): ActionResult {
    const side = this.sideOf(playerId);
    if (!side) return fail("Not your game");
    if (this.over) return fail("Game is over");
    if (this.game.turn !== side) return fail("Not your turn");
    if (ply !== this.ply) return fail("Out of sync");

    if (this.tc && this.running === side) {
      const elapsed = this.now() - this.turnStart;
      // Lag compensation: charge the player's own measured think time, but
      // never more than the hub saw elapse.
      const charged = Math.min(elapsed, Math.max(0, thinkMs ?? elapsed));
      if (this.remaining[side] - charged <= 0) {
        this.flag(side);
        return fail("Time is up");
      }
      this.remaining[side] -= charged;
    }

    const info = this.game.move(uci);
    if (!info) return fail("Illegal move");
    if (this.tc && this.running === side) this.remaining[side] += this.tc.incrementMs;

    if (this.drawOffer && this.drawOffer !== side) this.drawOffer = null;
    this.takeback = null;

    const status = this.game.status();
    if (status.over) {
      this.stopClock();
      this.finish(status.result!, status.reason!);
      return OK;
    }
    this.startTurnClock();
    this.changed();
    return OK;
  }

  /** Runs the clock for the side to move once both players have moved. */
  private startTurnClock(): void {
    this.clearFlagTimer();
    if (!this.tc || this.ply < 2) {
      this.running = null;
      return;
    }
    this.running = this.game.turn;
    this.turnStart = this.now();
    this.scheduleFlag();
  }

  private scheduleFlag(): void {
    if (!this.running) return;
    const side = this.running;
    const grace = this.opts.flagGraceMs?.(side) ?? 150;
    this.flagTimer = this.opts.clock.setTimeout(() => this.checkFlag(side, grace), this.remaining[side] + grace);
  }

  // Timers can wake early, so re-check and re-arm until time really is up.
  private checkFlag(side: Side, grace: number): void {
    this.flagTimer = null;
    if (this.over || this.running !== side) return;
    const left = this.remaining[side] - (this.now() - this.turnStart);
    if (left + grace <= 0) this.flag(side);
    else this.flagTimer = this.opts.clock.setTimeout(() => this.checkFlag(side, grace), left + grace);
  }

  private clearFlagTimer(): void {
    if (this.flagTimer !== null) this.opts.clock.clearTimeout(this.flagTimer);
    this.flagTimer = null;
  }

  private stopClock(): void {
    if (this.running) {
      this.remaining[this.running] = Math.max(0, this.remaining[this.running] - (this.now() - this.turnStart));
    }
    this.running = null;
    this.clearFlagTimer();
  }

  private flag(side: Side): void {
    this.stopClock();
    this.remaining[side] = 0;
    const status = this.game.timeoutResult(side);
    this.finish(status.result!, status.reason!);
  }

  resign(playerId: string): ActionResult {
    const side = this.sideOf(playerId);
    if (!side) return fail("Not your game");
    if (this.over) return fail("Game is over");
    if (this.abortable) return this.abort(playerId);
    this.stopClock();
    this.finish(side === "w" ? "0-1" : "1-0", "resign");
    return OK;
  }

  abort(playerId: string): ActionResult {
    if (!this.sideOf(playerId)) return fail("Not your game");
    if (!this.abortable) return fail("Too late to abort");
    this.stopClock();
    this.end(undefined, "aborted");
    return OK;
  }

  offerDraw(playerId: string): ActionResult {
    const side = this.sideOf(playerId);
    if (!side) return fail("Not your game");
    if (this.over) return fail("Game is over");
    if (this.drawOffer === otherSide(side)) return this.respondDraw(playerId, true);
    this.drawOffer = side;
    this.changed();
    return OK;
  }

  respondDraw(playerId: string, accept: boolean): ActionResult {
    const side = this.sideOf(playerId);
    if (!side) return fail("Not your game");
    if (this.over || this.drawOffer !== otherSide(side)) return fail("No draw offer");
    this.drawOffer = null;
    if (accept) {
      this.stopClock();
      this.finish("1/2-1/2", "agreement");
    } else {
      this.changed();
    }
    return OK;
  }

  requestTakeback(playerId: string): ActionResult {
    const side = this.sideOf(playerId);
    if (!side) return fail("Not your game");
    if (this.over) return fail("Game is over");
    const mine = this.game.moves.filter((m) => m.color === side).length;
    if (mine === 0) return fail("Nothing to take back");
    if (this.takeback === otherSide(side)) return this.respondTakeback(playerId, true);
    this.takeback = side;
    this.changed();
    return OK;
  }

  respondTakeback(playerId: string, accept: boolean): ActionResult {
    const side = this.sideOf(playerId);
    if (!side) return fail("Not your game");
    if (this.over || this.takeback !== otherSide(side)) return fail("No takeback request");
    const requester = this.takeback;
    this.takeback = null;
    if (accept) {
      // Undo back to the requester's turn. Clock times are not restored.
      this.stopClock();
      this.game.undo();
      if (this.game.turn !== requester) this.game.undo();
      this.drawOffer = null;
      this.startTurnClock();
    }
    this.changed();
    return OK;
  }

  offerRematch(playerId: string): ActionResult {
    const side = this.sideOf(playerId);
    if (!side) return fail("Not your game");
    if (!this.over) return fail("Game is still on");
    if (this.nextGameId) return fail("Rematch already started");
    this.rematch.add(side);
    this.changed();
    return OK;
  }

  get rematchAgreed(): boolean {
    return this.rematch.size === 2;
  }

  setNextGame(id: string): void {
    this.nextGameId = id;
    this.changed();
  }

  playerLeft(playerId: string): void {
    const side = this.sideOf(playerId);
    if (!side || this.over || this.gone[side] !== undefined) return;
    this.gone[side] = this.now();
    this.scheduleAbandon();
    this.changed();
  }

  playerReturned(playerId: string): void {
    const side = this.sideOf(playerId);
    if (!side || this.gone[side] === undefined) return;
    delete this.gone[side];
    this.scheduleAbandon();
    if (!this.over) this.changed();
  }

  private scheduleAbandon(): void {
    if (this.abandonTimer !== null) this.opts.clock.clearTimeout(this.abandonTimer);
    this.abandonTimer = null;
    const first = (["w", "b"] as Side[])
      .filter((s) => this.gone[s] !== undefined)
      .sort((a, b) => this.gone[a]! - this.gone[b]!)[0];
    if (!first || this.over) return;
    const wait = Math.max(0, this.gone[first]! + ABANDON_MS - this.now());
    this.abandonTimer = this.opts.clock.setTimeout(() => {
      this.abandonTimer = null;
      if (this.over || this.gone[first] === undefined) return;
      this.stopClock();
      if (this.ply < 2) this.end(undefined, "aborted");
      else this.finish(first === "w" ? "0-1" : "1-0", "abandon");
    }, wait);
  }

  private finish(result: Result, reason: EndReason): void {
    this.end(result, reason);
  }

  private end(result: Result | undefined, reason: EndReason | "aborted"): void {
    if (this.over) return;
    this.over = true;
    this.result = result;
    this.reason = reason;
    this.endedAt = this.now();
    this.drawOffer = null;
    this.takeback = null;
    this.clearFlagTimer();
    if (this.abandonTimer !== null) this.opts.clock.clearTimeout(this.abandonTimer);
    this.abandonTimer = null;
    this.opts.onFinish(this);
    this.changed();
  }

  dispose(): void {
    this.clearFlagTimer();
    if (this.abandonTimer !== null) this.opts.clock.clearTimeout(this.abandonTimer);
  }
}
