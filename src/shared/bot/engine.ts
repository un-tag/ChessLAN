// Alpha-beta search for the bot: iterative deepening negamax (PVS) with
// quiescence, a transposition table, null-move pruning, late-move
// reductions, check extension and MVV-LVA / killer / history ordering.
// Works directly on the shared Position; allocates nothing per node.
import {
  BLACK,
  F_CAPTURE,
  F_EP,
  F_PROMO,
  PAWN,
  QUEEN,
  WHITE,
  moveFlags,
  moveFrom,
  movePromo,
  moveTo,
  type Color,
  type Position,
} from "../chess/position";
import type { Evaluator } from "./eval";

export const MATE = 30000;
/** Scores beyond this (in absolute value) are mates. */
export const MATE_BOUND = MATE - 1000;
const INF = 32000;
const MAX_PLY = 100;

// Rough piece values for pruning decisions (not the evaluation).
const VALUE = [0, 100, 320, 330, 500, 900, 20000];

const TT_EXACT = 1;
const TT_LOWER = 2;
const TT_UPPER = 3;

export interface SearchLimits {
  /** Deepest iteration (plies). Default 64. */
  maxDepth?: number;
  /** Hard deadline in ms; no new iteration starts after half of it. Default 1000. */
  timeMs?: number;
  /** Node budget (search + quiescence nodes). Default unlimited. */
  maxNodes?: number;
  /**
   * When > 0, every root move is scored, not just the best: moves within this
   * many cp of the best get exact scores, worse ones an upper bound.
   */
  rootMargin?: number;
  /** Centipawns the root side gives up to avoid a draw. */
  contempt?: number;
}

export interface RootScore {
  move: number;
  score: number;
}

export interface SearchResult {
  /** Best move, 0 if there is no legal move. */
  move: number;
  /** Centipawns for the side to move; |score| > MATE_BOUND is a mate. */
  score: number;
  /** Last fully completed iteration. */
  depth: number;
  nodes: number;
  ms: number;
  /** Every legal root move with its score at `depth`, best first. */
  root: RootScore[];
}

/** Plies to mate for a mate score (positive: side to move mates), else null. */
export const matePlies = (score: number): number | null =>
  score > MATE_BOUND ? MATE - score : score < -MATE_BOUND ? -(MATE + score) : null;

export class Engine {
  // Transposition table, one slot per index, verified by the high hash word.
  private readonly ttMask: number;
  private readonly ttKey: Uint32Array;
  private readonly ttMove: Int32Array;
  private readonly ttScore: Int16Array;
  private readonly ttDepth: Int8Array;
  private readonly ttFlag: Uint8Array;
  private readonly ttGen: Uint8Array;
  private gen = 0;

  private pos!: Position;
  private ev!: Evaluator;
  private nodes = 0;
  private stopped = false;
  private canStop = false;
  private deadline = 0;
  private maxNodes = Infinity;
  private rootColor: Color = WHITE;
  private contempt = 0;
  private partialMove = 0;
  private partialScore = 0;

  private readonly moves: number[][] = [];
  private readonly orders: Int32Array[] = [];
  private readonly killers = new Int32Array(2 * (MAX_PLY + 1));
  private readonly history = new Int32Array(16 * 128);

  constructor(ttBits = 18) {
    const size = 1 << ttBits;
    this.ttMask = size - 1;
    this.ttKey = new Uint32Array(size);
    this.ttMove = new Int32Array(size);
    this.ttScore = new Int16Array(size);
    this.ttDepth = new Int8Array(size);
    this.ttFlag = new Uint8Array(size);
    this.ttGen = new Uint8Array(size);
    for (let i = 0; i <= MAX_PLY; i++) {
      this.moves.push([]);
      this.orders.push(new Int32Array(256));
    }
  }

  /** Searches `pos` (left unchanged on return). Always completes depth 1. */
  search(pos: Position, ev: Evaluator, limits: SearchLimits = {}): SearchResult {
    const start = Date.now();
    const timeMs = limits.timeMs ?? 1000;
    const maxDepth = Math.max(1, Math.min(limits.maxDepth ?? 64, MAX_PLY - 4));
    const margin = limits.rootMargin ?? 0;
    this.pos = pos;
    this.ev = ev;
    this.nodes = 0;
    this.stopped = false;
    this.canStop = false;
    this.deadline = start + timeMs;
    this.maxNodes = limits.maxNodes ?? Infinity;
    this.rootColor = pos.turn;
    this.contempt = limits.contempt ?? 0;
    this.killers.fill(0);
    this.history.fill(0);
    // A new generation invalidates the whole table (styles change the eval).
    this.gen = (this.gen + 1) & 255;
    if (!this.gen) {
      this.ttGen.fill(0);
      this.gen = 1;
    }

    const legal = pos.generateLegal();
    if (!legal.length) {
      const score = pos.inCheck() ? -MATE : 0;
      return { move: 0, score, depth: 0, nodes: 0, ms: Date.now() - start, root: [] };
    }
    const order = legal.map((m) => this.orderScore(m, 0, 0));
    let root: RootScore[] = legal
      .map((move, i) => ({ move, score: order[i] }))
      .sort((a, b) => b.score - a.score)
      .map((r) => ({ move: r.move, score: -INF }));
    const iter = new Int32Array(root.length);

    let best = root[0].move;
    let bestScore = 0;
    let depth = 0;
    for (let d = 1; d <= maxDepth; d++) {
      this.canStop = d > 1;
      this.searchRoot(root, d, margin, iter);
      if (this.stopped) {
        // Keep a better move found by the unfinished iteration (plain mode only).
        if (!margin && this.partialMove) {
          best = this.partialMove;
          bestScore = this.partialScore;
        }
        break;
      }
      depth = d;
      root = root.map((r, i) => ({ move: r.move, score: iter[i] })).sort((a, b) => b.score - a.score);
      best = root[0].move;
      bestScore = root[0].score;
      const mate = matePlies(bestScore);
      if (mate !== null && Math.abs(mate) <= d) break;
      if (Date.now() - start > timeMs / 2) break;
    }
    return { move: best, score: bestScore, depth, nodes: this.nodes, ms: Date.now() - start, root };
  }

  private searchRoot(root: RootScore[], depth: number, margin: number, out: Int32Array): void {
    const pos = this.pos;
    let alpha = -INF;
    let best = -INF;
    this.partialMove = 0;
    for (let i = 0; i < root.length; i++) {
      const m = root[i].move;
      pos.makeMove(m);
      let score: number;
      if (margin > 0) {
        // Window (best - margin, INF): close rivals get exact scores.
        const a = best === -INF ? -INF : best - margin;
        score = -this.negamax(depth - 1, -INF, -a, 1, true);
      } else if (i === 0) {
        score = -this.negamax(depth - 1, -INF, -alpha, 1, true);
      } else {
        score = -this.negamax(depth - 1, -alpha - 1, -alpha, 1, true);
        if (score > alpha && !this.stopped) score = -this.negamax(depth - 1, -INF, -alpha, 1, true);
      }
      pos.unmakeMove();
      if (this.stopped) return;
      out[i] = score;
      if (score > best) {
        best = score;
        if (score > alpha) alpha = score;
        this.partialMove = m;
        this.partialScore = score;
      }
    }
  }

  private drawScore(): number {
    return this.pos.turn === this.rootColor ? -this.contempt : this.contempt;
  }

  private checkLimits(): void {
    if (this.canStop && (this.nodes >= this.maxNodes || Date.now() >= this.deadline)) this.stopped = true;
  }

  private negamax(depth: number, alpha: number, beta: number, ply: number, allowNull: boolean): number {
    const pos = this.pos;
    if (pos.halfmove >= 100 || pos.repetitions() >= 2) return this.drawScore();
    // Material only changes on captures (halfmove reset).
    if (pos.halfmove === 0 && pos.insufficientMaterial()) return this.drawScore();
    if (ply >= MAX_PLY) return this.ev.evaluate(pos);

    // Mate distance pruning.
    if (alpha < -MATE + ply) alpha = -MATE + ply;
    if (beta > MATE - ply - 1) beta = MATE - ply - 1;
    if (alpha >= beta) return alpha;

    const inCheck = pos.inCheck();
    if (inCheck) depth++;
    if (depth <= 0) return this.quiesce(alpha, beta, ply);

    if ((++this.nodes & 1023) === 0) this.checkLimits();
    if (this.stopped) return 0;

    const pv = beta - alpha > 1;
    const idx = pos.hashLo & this.ttMask;
    let ttMove = 0;
    if (this.ttGen[idx] === this.gen && this.ttKey[idx] === pos.hashHi) {
      ttMove = this.ttMove[idx];
      if (!pv && this.ttDepth[idx] >= depth) {
        let s = this.ttScore[idx];
        if (s > MATE_BOUND) s -= ply;
        else if (s < -MATE_BOUND) s += ply;
        const f = this.ttFlag[idx];
        if (f === TT_EXACT || (f === TT_LOWER && s >= beta) || (f === TT_UPPER && s <= alpha)) return s;
      }
    }

    if (!pv && !inCheck) {
      const staticEval = this.ev.evaluate(pos);
      // Reverse futility: far above beta at low depth.
      if (depth <= 3 && beta > -MATE_BOUND && beta < MATE_BOUND && staticEval - 110 * depth >= beta) {
        return staticEval;
      }
      // Null move, skipped without pieces (zugzwang in pawn endings).
      if (allowNull && depth >= 3 && staticEval >= beta && this.ev.npm[pos.turn] > 0) {
        const r = depth >= 7 ? 3 : 2;
        pos.makeNullMove();
        const s = -this.negamax(depth - 1 - r, -beta, -beta + 1, ply + 1, false);
        pos.unmakeNullMove();
        if (this.stopped) return 0;
        if (s >= beta) return s >= MATE_BOUND ? beta : s;
      }
    }

    const moves = this.moves[ply];
    moves.length = 0;
    pos.generatePseudo(moves, false);
    const order = this.orders[ply];
    for (let i = 0; i < moves.length; i++) order[i] = this.orderScore(moves[i], ttMove, ply);

    const alphaOrig = alpha;
    const k0 = this.killers[ply * 2];
    const k1 = this.killers[ply * 2 + 1];
    let best = -INF;
    let bestMove = 0;
    let legal = 0;
    for (let i = 0; i < moves.length; i++) {
      // Selection sort: bring the best-ordered remaining move to i.
      let bi = i;
      for (let j = i + 1; j < moves.length; j++) if (order[j] > order[bi]) bi = j;
      const m = moves[bi];
      if (bi !== i) {
        moves[bi] = moves[i];
        moves[i] = m;
        const o = order[bi];
        order[bi] = order[i];
        order[i] = o;
      }
      const quiet = !(moveFlags(m) & (F_CAPTURE | F_PROMO));
      const piece = pos.board[moveFrom(m)];
      if (!pos.makeMove(m)) continue;
      legal++;
      let score: number;
      if (legal === 1) {
        score = -this.negamax(depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        // Late quiet moves get a reduced null-window look first.
        let r = 0;
        if (depth >= 3 && quiet && legal > 3 && !inCheck && m !== k0 && m !== k1 && !pos.inCheck()) {
          r = legal > 8 && depth >= 5 ? 2 : 1;
        }
        score = -this.negamax(depth - 1 - r, -alpha - 1, -alpha, ply + 1, true);
        if (score > alpha && r > 0) score = -this.negamax(depth - 1, -alpha - 1, -alpha, ply + 1, true);
        if (score > alpha && score < beta) score = -this.negamax(depth - 1, -beta, -alpha, ply + 1, true);
      }
      pos.unmakeMove();
      if (this.stopped) return 0;
      if (score > best) {
        best = score;
        bestMove = m;
        if (score > alpha) {
          alpha = score;
          if (score >= beta) {
            if (quiet) {
              if (m !== k0) {
                this.killers[ply * 2 + 1] = k0;
                this.killers[ply * 2] = m;
              }
              const h = (piece << 7) | moveTo(m);
              this.history[h] += depth * depth;
              if (this.history[h] > 1_000_000) for (let j = 0; j < this.history.length; j++) this.history[j] >>= 1;
            }
            break;
          }
        }
      }
    }
    if (!legal) return inCheck ? -MATE + ply : this.drawScore();

    const flag = best >= beta ? TT_LOWER : best > alphaOrig ? TT_EXACT : TT_UPPER;
    this.store(idx, pos.hashHi, depth, best, flag, bestMove, ply);
    return best;
  }

  private quiesce(alpha: number, beta: number, ply: number): number {
    const pos = this.pos;
    if ((++this.nodes & 1023) === 0) this.checkLimits();
    if (this.stopped) return 0;
    if (ply >= MAX_PLY) return this.ev.evaluate(pos);

    // In check: no standing pat, every evasion is searched.
    const inCheck = pos.inCheck();
    let best = -INF;
    if (!inCheck) {
      best = this.ev.evaluate(pos);
      if (best >= beta) return best;
      if (best > alpha) alpha = best;
    }

    const moves = this.moves[ply];
    moves.length = 0;
    pos.generatePseudo(moves, !inCheck);
    const order = this.orders[ply];
    for (let i = 0; i < moves.length; i++) order[i] = this.orderScore(moves[i], 0, ply);

    const b = pos.board;
    const them = (pos.turn ^ 1) as Color;
    let legal = 0;
    for (let i = 0; i < moves.length; i++) {
      let bi = i;
      for (let j = i + 1; j < moves.length; j++) if (order[j] > order[bi]) bi = j;
      const m = moves[bi];
      if (bi !== i) {
        moves[bi] = moves[i];
        moves[i] = m;
        const o = order[bi];
        order[bi] = order[i];
        order[i] = o;
      }
      if (!inCheck) {
        const promo = movePromo(m);
        if (promo && promo !== QUEEN) continue;
        if (!promo) {
          const to = moveTo(m);
          const victim = VALUE[moveFlags(m) & F_EP ? PAWN : b[to] & 7];
          // Delta pruning, and skip captures a pawn simply takes back.
          if (best + victim + 200 <= alpha) continue;
          if (VALUE[b[moveFrom(m)] & 7] > victim + 50 && this.pawnGuards(to, them)) continue;
        }
      }
      if (!pos.makeMove(m)) continue;
      legal++;
      const score = -this.quiesce(-beta, -alpha, ply + 1);
      pos.unmakeMove();
      if (this.stopped) return 0;
      if (score > best) {
        best = score;
        if (score > alpha) {
          alpha = score;
          if (score >= beta) break;
        }
      }
    }
    if (inCheck && !legal) return -MATE + ply;
    return best;
  }

  private pawnGuards(s: number, by: Color): boolean {
    const b = this.pos.board;
    if (by === BLACK) {
      return (!((s + 15) & 0x88) && b[s + 15] === 9) || (!((s + 17) & 0x88) && b[s + 17] === 9);
    }
    return (!((s - 15) & 0x88) && b[s - 15] === 1) || (!((s - 17) & 0x88) && b[s - 17] === 1);
  }

  private orderScore(m: number, ttMove: number, ply: number): number {
    if (m === ttMove) return 4_000_000;
    const b = this.pos.board;
    const flags = moveFlags(m);
    const promo = movePromo(m);
    if (flags & F_CAPTURE) {
      const victim = flags & F_EP ? PAWN : b[moveTo(m)] & 7;
      return 2_000_000 + victim * 64 - (b[moveFrom(m)] & 7) + (promo === QUEEN ? 1000 : 0);
    }
    if (flags & F_PROMO) return promo === QUEEN ? 2_000_500 : -1;
    if (m === this.killers[ply * 2]) return 1_500_000;
    if (m === this.killers[ply * 2 + 1]) return 1_400_000;
    return this.history[(b[moveFrom(m)] << 7) | moveTo(m)];
  }

  private store(idx: number, key: number, depth: number, score: number, flag: number, move: number, ply: number): void {
    const same = this.ttGen[idx] === this.gen && this.ttKey[idx] === key;
    if (same && depth < this.ttDepth[idx] && flag !== TT_EXACT) return;
    if (score > MATE_BOUND) score += ply;
    else if (score < -MATE_BOUND) score -= ply;
    this.ttGen[idx] = this.gen;
    this.ttKey[idx] = key;
    this.ttDepth[idx] = depth;
    this.ttScore[idx] = score;
    this.ttFlag[idx] = flag;
    if (move || !same) this.ttMove[idx] = move;
  }
}
