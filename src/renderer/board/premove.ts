// Pure board logic for the chessboard component: a light piece model,
// FEN placement parsing, applying moves and queued premoves, premove
// geometry (chessground style), the piece diff that drives animation, and
// screen geometry (orientation, hit testing, arrows, promotion picker).
// No DOM and no React here so it can be unit tested.

export type Side = "w" | "b";
export type Role = "K" | "Q" | "R" | "B" | "N" | "P";
export type PieceCode = `${Side}${Role}`;
export type Promotion = "q" | "r" | "b" | "n";

export interface PremoveSpec {
  from: string;
  to: string;
  promotion?: Promotion;
}

/** 64 entries, index 0 = a1, 7 = h1, 63 = h8 (same layout as Game.board()). */
export type Pieces = (PieceCode | null)[];

const FILES = "abcdefgh";
const ROLES = "KQRBNP";

export const otherSide = (s: Side): Side => (s === "w" ? "b" : "w");

/** "e4" -> 28; -1 for anything that isn't a square. */
export function sqIndex(sq: string): number {
  if (sq.length !== 2) return -1;
  const f = sq.charCodeAt(0) - 97;
  const r = sq.charCodeAt(1) - 49;
  return f >= 0 && f < 8 && r >= 0 && r < 8 ? r * 8 + f : -1;
}

/** 28 -> "e4". */
export function sqName(i: number): string {
  return FILES[i & 7] + String((i >> 3) + 1);
}

export interface ParsedFen {
  pieces: Pieces;
  turn: Side;
  castling: string;
}

/** Placement, side to move and castling rights. Malformed input gives an empty board. */
export function parseFen(fen: string): ParsedFen {
  const pieces: Pieces = new Array<PieceCode | null>(64).fill(null);
  const [placement = "", turn = "w", castling = "-"] = fen.trim().split(/\s+/);
  const ranks = placement.split("/");
  if (ranks.length === 8) {
    for (let r = 0; r < 8; r++) {
      let f = 0;
      for (const ch of ranks[r]) {
        if (ch >= "1" && ch <= "8") {
          f += ch.charCodeAt(0) - 48;
          continue;
        }
        const role = ch.toUpperCase();
        if (f > 7 || !ROLES.includes(role)) continue;
        pieces[(7 - r) * 8 + f] = `${ch === role ? "w" : "b"}${role as Role}`;
        f++;
      }
    }
  }
  return { pieces, turn: turn === "b" ? "b" : "w", castling };
}

export function sameBoard(a: Pieces, b: Pieces): boolean {
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface ApplyOptions {
  /** Piece a pawn turns into on the last rank. Omitted: it stays a pawn (preview). */
  promotion?: Role | Lowercase<Role>;
  /** Remove the pawn behind a diagonal pawn move to an empty square. Default true. */
  enPassant?: boolean;
}

/**
 * Returns a copy of `pieces` with the piece on `from` moved to `to`.
 * Handles castling (king moving two files also moves the corner rook),
 * en passant and promotion. Does not check legality.
 */
export function applyMove(pieces: Pieces, from: string, to: string, opts: ApplyOptions = {}): Pieces {
  const f = sqIndex(from);
  const t = sqIndex(to);
  const out = pieces.slice();
  const piece = f >= 0 ? out[f] : null;
  if (!piece || t < 0 || f === t) return out;
  const color = piece[0] as Side;
  const role = piece[1] as Role;
  const df = (t & 7) - (f & 7);
  out[f] = null;
  if (role === "K" && t >> 3 === f >> 3 && Math.abs(df) === 2) {
    const rank = f & ~7;
    const rookFrom = df > 0 ? rank + 7 : rank;
    const rookTo = df > 0 ? t - 1 : t + 1;
    if (out[rookFrom] === `${color}R`) {
      out[rookFrom] = null;
      out[rookTo] = `${color}R`;
    }
  }
  let placed: PieceCode = piece;
  if (role === "P") {
    if (df !== 0 && !out[t] && opts.enPassant !== false) {
      const behind = (f & ~7) | (t & 7);
      if (out[behind] === `${otherSide(color)}P`) out[behind] = null;
    }
    const lastRank = color === "w" ? 7 : 0;
    if (t >> 3 === lastRank && opts.promotion) {
      placed = `${color}${opts.promotion.toUpperCase() as Role}`;
    }
  }
  out[t] = placed;
  return out;
}

/**
 * The board as it will look after the queued premoves, drawn the way the
 * user expects them: each premove just moves its piece (promotions default
 * to a queen). Premoves whose origin is empty are skipped.
 */
export function applyPremoves(pieces: Pieces, premoves: readonly PremoveSpec[]): Pieces {
  let out = pieces;
  for (const p of premoves) {
    const f = sqIndex(p.from);
    if (f < 0 || !out[f]) continue;
    out = applyMove(out, p.from, p.to, { promotion: p.promotion ?? "q", enPassant: false });
  }
  return out;
}

/** Castling rights minus those spent by a queued premove (king or rook leaving home). */
export function castlingAfterPremoves(castling: string, premoves: readonly PremoveSpec[]): string {
  let rights = castling === "-" ? "" : castling;
  const drop = (chars: string) => {
    for (const c of chars) rights = rights.replace(c, "");
  };
  for (const p of premoves) {
    for (const sq of [p.from, p.to]) {
      if (sq === "e1") drop("KQ");
      else if (sq === "h1") drop("K");
      else if (sq === "a1") drop("Q");
      else if (sq === "e8") drop("kq");
      else if (sq === "h8") drop("k");
      else if (sq === "a8") drop("q");
    }
  }
  return rights;
}

/**
 * Premove destinations for the piece on `from`, chessground style: sliders
 * move along their lines ignoring every blocker, knights move normally,
 * pawns go one square forward (two from their start rank) or one square
 * diagonally regardless of what is there, and the king steps one square or
 * castles from its start square when the right (if `castling` is given) and
 * the corner rook are still there. Squares with own pieces are included,
 * since that piece may be captured first (the classic recapture premove).
 */
export function premoveDests(pieces: Pieces, from: string, castling?: string): string[] {
  const f = sqIndex(from);
  const piece = f >= 0 ? pieces[f] : null;
  if (!piece) return [];
  const color = piece[0] as Side;
  const role = piece[1] as Role;
  const x1 = f & 7;
  const y1 = f >> 3;
  const out: string[] = [];
  for (let t = 0; t < 64; t++) {
    if (t === f) continue;
    const x2 = t & 7;
    const y2 = t >> 3;
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    let ok = false;
    switch (role) {
      case "P": {
        const dir = color === "w" ? 1 : -1;
        const start = color === "w" ? 1 : 6;
        ok = (dx <= 1 && y2 - y1 === dir) || (dx === 0 && y1 === start && y2 - y1 === 2 * dir);
        break;
      }
      case "N":
        ok = (dx === 1 && dy === 2) || (dx === 2 && dy === 1);
        break;
      case "B":
        ok = dx === dy;
        break;
      case "R":
        ok = dx === 0 || dy === 0;
        break;
      case "Q":
        ok = dx === dy || dx === 0 || dy === 0;
        break;
      case "K": {
        ok = dx <= 1 && dy <= 1;
        const home = color === "w" ? 0 : 7;
        if (!ok && dy === 0 && y1 === home && x1 === 4 && (x2 === 6 || x2 === 2)) {
          const kingSide = x2 === 6;
          const right = color === "w" ? (kingSide ? "K" : "Q") : kingSide ? "k" : "q";
          const rookSq = home * 8 + (kingSide ? 7 : 0);
          ok = (castling === undefined || castling.includes(right)) && pieces[rookSq] === `${color}R`;
        }
        break;
      }
    }
    if (ok) out.push(sqName(t));
  }
  return out;
}

/** Square pairs that move when `from`->`to` is played on `pieces` (castling adds the rook). */
export function moveHints(pieces: Pieces, from: string, to: string): [number, number][] {
  const f = sqIndex(from);
  const t = sqIndex(to);
  if (f < 0 || t < 0) return [];
  const hints: [number, number][] = [[f, t]];
  const piece = pieces[f];
  const df = (t & 7) - (f & 7);
  if (piece?.[1] === "K" && t >> 3 === f >> 3 && Math.abs(df) === 2) {
    const rank = f & ~7;
    hints.push(df > 0 ? [rank + 7, t - 1] : [rank, t + 1]);
  }
  return hints;
}

/** True when `after` is exactly `before` with `from`->`to` played (castling, en passant, promotion). */
export function isSingleMove(before: Pieces, after: Pieces, from: string, to: string): boolean {
  const f = sqIndex(from);
  const t = sqIndex(to);
  if (f < 0 || t < 0 || !before[f]) return false;
  const landed = after[t];
  const promotion = before[f]![1] === "P" && landed && landed[1] !== "P" ? (landed[1] as Role) : undefined;
  return sameBoard(applyMove(before, from, to, { promotion }), after);
}

/**
 * Finds the piece moves between two boards when the change is small: at
 * most four squares differ (a move, a capture, en passant or castling) and
 * every piece that appeared can be traced to a piece of the same kind (or a
 * pawn promoting) that left. Returns null for anything bigger.
 */
export function diffMoves(before: Pieces, after: Pieces): [number, number][] | null {
  const vanished: number[] = [];
  const appeared: number[] = [];
  for (let i = 0; i < 64; i++) {
    if (before[i] === after[i]) continue;
    if (before[i]) vanished.push(i);
    if (after[i]) appeared.push(i);
    if (vanished.length > 4 || appeared.length > 2) return null;
  }
  const out: [number, number][] = [];
  const used = new Set<number>();
  for (const t of appeared) {
    const code = after[t]!;
    const lastRank = code[0] === "w" ? 7 : 0;
    const src = vanished.find(
      (v) =>
        !used.has(v) &&
        (before[v] === code ||
          (before[v] === `${code[0]}P` && t >> 3 === lastRank && Math.abs((v >> 3) - (t >> 3)) === 1)),
    );
    if (src === undefined) return null;
    used.add(src);
    out.push([src, t]);
  }
  return out;
}

/** A piece element on screen; `id` is a stable React key. */
export interface PlacedPiece {
  id: number;
  sq: number;
  code: PieceCode;
  /** How it got to `sq` in this layout: it stayed, slides there, or jumps there. */
  motion: "none" | "animate" | "instant";
}

/**
 * Assigns stable ids to the pieces of `next` by matching them against the
 * previous layout, so React reuses DOM nodes: a piece that stays keeps its
 * id; a hinted move (from, to) keeps the moving piece's id and is marked to
 * animate (a pawn may become its promotion piece); any other piece that
 * moved is matched to the nearest vanished piece of the same kind and jumps.
 * The result is sorted by id so existing elements never change DOM order
 * (re-inserting a node would cancel its CSS transition).
 */
export function placePieces(
  prev: readonly PlacedPiece[] | null,
  next: Pieces,
  hints: readonly [number, number][],
  newId: () => number,
  allInstant = false,
): PlacedPiece[] {
  const placed: (PlacedPiece | undefined)[] = new Array(64);
  if (prev) {
    const prevAt: (PlacedPiece | undefined)[] = new Array(64);
    for (const p of prev) prevAt[p.sq] = p;
    const used = new Set<number>();
    for (let i = 0; i < 64; i++) {
      const p = prevAt[i];
      if (p && next[i] === p.code) {
        placed[i] = { id: p.id, sq: i, code: p.code, motion: allInstant ? "instant" : "none" };
        used.add(p.id);
      }
    }
    for (const [f, t] of hints) {
      const p = prevAt[f];
      const code = next[t];
      if (!p || !code || used.has(p.id) || placed[t]) continue;
      if (p.code !== code && !(p.code === `${code[0]}P`)) continue;
      placed[t] = { id: p.id, sq: t, code, motion: allInstant ? "instant" : "animate" };
      used.add(p.id);
    }
    for (let i = 0; i < 64; i++) {
      const code = next[i];
      if (!code || placed[i]) continue;
      let best: PlacedPiece | undefined;
      let bestDist = Infinity;
      for (const p of prev) {
        if (used.has(p.id) || p.code !== code) continue;
        const dx = (p.sq & 7) - (i & 7);
        const dy = (p.sq >> 3) - (i >> 3);
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      if (best) {
        used.add(best.id);
        placed[i] = { id: best.id, sq: i, code, motion: "instant" };
      }
    }
  }
  for (let i = 0; i < 64; i++) {
    const code = next[i];
    if (code && !placed[i]) placed[i] = { id: newId(), sq: i, code, motion: "none" };
  }
  return (placed.filter(Boolean) as PlacedPiece[]).sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------------------
// Screen geometry. Display coordinates: col 0 = left, row 0 = top.

export interface Cell {
  col: number;
  row: number;
}

export function squareToCell(sq: string | number, orientation: Side): Cell {
  const i = typeof sq === "number" ? sq : sqIndex(sq);
  const file = i & 7;
  const rank = i >> 3;
  return orientation === "w" ? { col: file, row: 7 - rank } : { col: 7 - file, row: rank };
}

export function cellToSquare(col: number, row: number, orientation: Side): string | null {
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  return orientation === "w" ? sqName((7 - row) * 8 + col) : sqName(row * 8 + (7 - col));
}

/** Square under a point given relative to the board's top-left corner; null off the board. */
export function pointToSquare(x: number, y: number, width: number, height: number, orientation: Side): string | null {
  if (!(width > 0 && height > 0) || x < 0 || y < 0 || x >= width || y >= height) return null;
  return cellToSquare(Math.floor((x * 8) / width), Math.floor((y * 8) / height), orientation);
}

export interface ArrowShape {
  /** Shaft polyline in board units (viewBox 0 0 8 8), drawn as a stroke. */
  shaft: string;
  /** Arrowhead polygon points. */
  head: string;
}

export const ARROW = { width: 0.22, headWidth: 0.56, headLength: 0.42, tailOffset: 0.28 };

/**
 * chess.com-style arrow from the centre of `from` towards the centre of
 * `to`. Knight jumps get an L-shaped arrow (long leg first).
 */
export function arrowShape(from: string, to: string, orientation: Side): ArrowShape {
  const a = squareToCell(from, orientation);
  const b = squareToCell(to, orientation);
  const sx = a.col + 0.5;
  const sy = a.row + 0.5;
  const ex = b.col + 0.5;
  const ey = b.row + 0.5;
  const adx = Math.abs(ex - sx);
  const ady = Math.abs(ey - sy);
  const knight = (adx === 1 && ady === 2) || (adx === 2 && ady === 1);
  const r = (n: number) => Math.round(n * 1000) / 1000;
  const pt = (x: number, y: number) => `${r(x)},${r(y)}`;
  // Last leg: corner (or start) -> end.
  let cx = sx;
  let cy = sy;
  if (knight) {
    if (ady > adx) cy = ey;
    else cx = ex;
  }
  const len = Math.hypot(ex - cx, ey - cy) || 1;
  const ux = (ex - cx) / len;
  const uy = (ey - cy) / len;
  const bx = ex - ux * ARROW.headLength;
  const by = ey - uy * ARROW.headLength;
  const hw = ARROW.headWidth / 2;
  const head = [pt(ex, ey), pt(bx - uy * hw, by + ux * hw), pt(bx + uy * hw, by - ux * hw)].join(" ");
  // The shaft runs a hair into the head so there is no seam between them.
  const overlap = 0.02;
  const shaftEnd = pt(bx + ux * overlap, by + uy * overlap);
  let shaft: string;
  if (knight) {
    const l1 = Math.hypot(cx - sx, cy - sy);
    const vx = (cx - sx) / l1;
    const vy = (cy - sy) / l1;
    shaft = `${pt(sx + vx * ARROW.tailOffset, sy + vy * ARROW.tailOffset)} ${pt(cx, cy)} ${shaftEnd}`;
  } else {
    shaft = `${pt(sx + ux * ARROW.tailOffset, sy + uy * ARROW.tailOffset)} ${shaftEnd}`;
  }
  return { shaft, head };
}

/**
 * Where the promotion picker goes: the column of the promotion square, and
 * whether it hangs down from the top edge or grows up from the bottom edge
 * (always towards the board centre).
 */
export function promotionPlacement(to: string, orientation: Side): { col: number; fromTop: boolean } {
  const { col, row } = squareToCell(to, orientation);
  return { col, fromTop: row < 4 };
}
