// Friendly game API on top of Position: string squares, SAN, game status
// and PGN. Used by the hub (authoritative rules) and the UI.
import {
  BLACK,
  F_CAPTURE,
  F_CASTLE,
  F_EP,
  PAWN,
  Position,
  START_FEN,
  WHITE,
  moveFlags,
  moveFrom,
  movePromo,
  moveTo,
  moveToUci,
  parseSquare,
  pieceColor,
  pieceType,
  squareName,
  type Color,
} from "./position";

export type Side = "w" | "b";
export type PieceSymbol = "p" | "n" | "b" | "r" | "q" | "k";
export interface Piece {
  color: Side;
  type: PieceSymbol;
}

export interface MoveInfo {
  from: string;
  to: string;
  uci: string;
  san: string;
  color: Side;
  piece: PieceSymbol;
  captured?: PieceSymbol;
  promotion?: PieceSymbol;
  castle?: "k" | "q";
  enPassant?: boolean;
  check: boolean;
  mate: boolean;
}

export type Result = "1-0" | "0-1" | "1/2-1/2";
export type EndReason =
  | "checkmate"
  | "stalemate"
  | "repetition"
  | "fifty"
  | "insufficient"
  | "resign"
  | "timeout"
  | "timeout-insufficient"
  | "agreement"
  | "abandon";

export interface GameStatus {
  over: boolean;
  result?: Result;
  reason?: EndReason;
}

const SYMBOLS = " pnbrqk";
const toSide = (c: Color): Side => (c === WHITE ? "w" : "b");
export const sideToColor = (s: Side): Color => (s === "w" ? WHITE : BLACK);
export const otherSide = (s: Side): Side => (s === "w" ? "b" : "w");

function stripSan(san: string): string {
  return san.replace(/[+#?!]+$/, "").replace(/0/g, "O").replace(/=/, "");
}

export class Game {
  readonly startFen: string;
  private pos: Position;
  private history: MoveInfo[] = [];

  constructor(fen: string = START_FEN) {
    this.startFen = fen;
    this.pos = Position.fromFen(fen);
  }

  static fromUci(moves: string[], fen?: string): Game {
    const g = new Game(fen);
    for (const m of moves) {
      if (!g.move(m)) throw new Error(`Illegal move in history: ${m}`);
    }
    return g;
  }

  get turn(): Side {
    return toSide(this.pos.turn);
  }

  get moves(): readonly MoveInfo[] {
    return this.history;
  }

  get uciMoves(): string[] {
    return this.history.map((m) => m.uci);
  }

  get lastMove(): MoveInfo | undefined {
    return this.history[this.history.length - 1];
  }

  fen(): string {
    return this.pos.fen();
  }

  inCheck(): boolean {
    return this.pos.inCheck();
  }

  /** Board as 64 entries, index 0 = a1, 7 = h1, 63 = h8. */
  board(): (Piece | null)[] {
    const out: (Piece | null)[] = new Array(64).fill(null);
    for (let i = 0; i < 64; i++) {
      const p = this.pos.board[(i >> 3) * 16 + (i & 7)];
      if (p) out[i] = { color: toSide(pieceColor(p)), type: SYMBOLS[pieceType(p)] as PieceSymbol };
    }
    return out;
  }

  get(square: string): Piece | null {
    const s = parseSquare(square);
    if (s < 0) return null;
    const p = this.pos.board[s];
    return p ? { color: toSide(pieceColor(p)), type: SYMBOLS[pieceType(p)] as PieceSymbol } : null;
  }

  kingSquare(side: Side): string {
    return squareName(this.pos.kings[sideToColor(side)]);
  }

  /** Legal destinations per origin square for the side to move. */
  legalDests(): Map<string, string[]> {
    const dests = new Map<string, string[]>();
    for (const m of this.pos.generateLegal()) {
      const from = squareName(moveFrom(m));
      const to = squareName(moveTo(m));
      const list = dests.get(from);
      if (!list) dests.set(from, [to]);
      else if (!list.includes(to)) list.push(to);
    }
    return dests;
  }

  isPromotion(from: string, to: string): boolean {
    const p = this.pos.board[parseSquare(from)];
    if (!p || pieceType(p) !== PAWN) return false;
    const rank = to[1];
    return rank === "8" || rank === "1";
  }

  private findMove(from: string, to: string, promotion?: string): number | null {
    const f = parseSquare(from);
    const t = parseSquare(to);
    if (f < 0 || t < 0) return null;
    const promoType = promotion ? SYMBOLS.indexOf(promotion.toLowerCase()) : 0;
    for (const m of this.pos.generateLegal()) {
      if (moveFrom(m) !== f || moveTo(m) !== t) continue;
      const mp = movePromo(m);
      if (mp && mp !== (promoType || 5)) continue; // default promotion: queen
      if (!mp && promoType) continue;
      return m;
    }
    return null;
  }

  /** SAN for an encoded legal move in the current position. */
  private sanOf(m: number, legal: number[]): string {
    const pos = this.pos;
    const from = moveFrom(m);
    const to = moveTo(m);
    const flags = moveFlags(m);
    const piece = pos.board[from];
    const type = pieceType(piece);
    let san: string;
    if (flags & F_CASTLE) {
      san = to > from ? "O-O" : "O-O-O";
    } else {
      const capture = (flags & F_CAPTURE) !== 0;
      if (type === PAWN) {
        san = capture ? squareName(from)[0] + "x" : "";
      } else {
        san = SYMBOLS[type].toUpperCase();
        // Disambiguate between identical pieces that can reach `to`.
        const rivals = legal.filter(
          (o) => o !== m && moveTo(o) === to && pos.board[moveFrom(o)] === piece,
        );
        if (rivals.length) {
          const sameFile = rivals.some((o) => (moveFrom(o) & 7) === (from & 7));
          const sameRank = rivals.some((o) => moveFrom(o) >> 4 === from >> 4);
          if (!sameFile) san += squareName(from)[0];
          else if (!sameRank) san += squareName(from)[1];
          else san += squareName(from);
        }
        if (capture) san += "x";
      }
      san += squareName(to);
      if (movePromo(m)) san += "=" + SYMBOLS[movePromo(m)].toUpperCase();
    }
    pos.makeMove(m);
    if (pos.inCheck()) san += pos.hasLegalMove() ? "+" : "#";
    pos.unmakeMove();
    return san;
  }

  private play(m: number): MoveInfo {
    const pos = this.pos;
    const legal = pos.generateLegal();
    const san = this.sanOf(m, legal);
    const from = moveFrom(m);
    const to = moveTo(m);
    const flags = moveFlags(m);
    const piece = pos.board[from];
    const capturedPiece =
      flags & F_EP ? pos.board[pos.turn === WHITE ? to - 16 : to + 16] : pos.board[to];
    const info: MoveInfo = {
      from: squareName(from),
      to: squareName(to),
      uci: moveToUci(m),
      san,
      color: toSide(pos.turn),
      piece: SYMBOLS[pieceType(piece)] as PieceSymbol,
      check: san.endsWith("+") || san.endsWith("#"),
      mate: san.endsWith("#"),
    };
    if (capturedPiece) info.captured = SYMBOLS[pieceType(capturedPiece)] as PieceSymbol;
    if (movePromo(m)) info.promotion = SYMBOLS[movePromo(m)] as PieceSymbol;
    if (flags & F_CASTLE) info.castle = to > from ? "k" : "q";
    if (flags & F_EP) info.enPassant = true;
    pos.makeMove(m);
    this.history.push(info);
    return info;
  }

  /**
   * Plays a move given as UCI ("e2e4", "e7e8q"), SAN ("Nf3") or squares.
   * Returns null if the move is illegal.
   */
  move(input: string | { from: string; to: string; promotion?: string }): MoveInfo | null {
    if (this.status().over) return null;
    let m: number | null = null;
    if (typeof input !== "string") {
      m = this.findMove(input.from, input.to, input.promotion);
    } else if (/^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/.test(input)) {
      m = this.findMove(input.slice(0, 2), input.slice(2, 4), input[4]);
    } else {
      m = this.findSan(input);
    }
    return m === null ? null : this.play(m);
  }

  private findSan(san: string): number | null {
    const want = stripSan(san);
    const legal = this.pos.generateLegal();
    for (const m of legal) {
      if (stripSan(this.sanOf(m, legal)) === want) return m;
    }
    return null;
  }

  undo(): MoveInfo | null {
    const last = this.history.pop();
    if (!last) return null;
    this.pos.unmakeMove();
    return last;
  }

  status(): GameStatus {
    const pos = this.pos;
    if (!pos.hasLegalMove()) {
      if (pos.inCheck()) return { over: true, result: pos.turn === WHITE ? "0-1" : "1-0", reason: "checkmate" };
      return { over: true, result: "1/2-1/2", reason: "stalemate" };
    }
    if (pos.insufficientMaterial()) return { over: true, result: "1/2-1/2", reason: "insufficient" };
    if (pos.halfmove >= 100) return { over: true, result: "1/2-1/2", reason: "fifty" };
    if (pos.repetitions() >= 3) return { over: true, result: "1/2-1/2", reason: "repetition" };
    return { over: false };
  }

  /** Result if `loser` runs out of time: a draw if the winner can't mate. */
  timeoutResult(loser: Side): GameStatus {
    const winner = otherSide(loser);
    if (this.pos.cannotWin(sideToColor(winner))) {
      return { over: true, result: "1/2-1/2", reason: "timeout-insufficient" };
    }
    return { over: true, result: winner === "w" ? "1-0" : "0-1", reason: "timeout" };
  }

  /** Material on board per side, in pawns (P1 N3 B3 R5 Q9). */
  material(): { w: number; b: number } {
    const values = [0, 1, 3, 3, 5, 9, 0];
    const out = { w: 0, b: 0 };
    for (let i = 0; i < 64; i++) {
      const p = this.pos.board[(i >> 3) * 16 + (i & 7)];
      if (p) out[toSide(pieceColor(p))] += values[pieceType(p)];
    }
    return out;
  }

  /** The underlying fast position (for the bot). Do not mutate. */
  get position(): Position {
    return this.pos;
  }
}

export interface PgnHeaders {
  white: string;
  black: string;
  result?: Result | "*";
  date?: Date;
  timeControl?: string;
  termination?: string;
  event?: string;
}

export function toPgn(moves: readonly MoveInfo[], h: PgnHeaders): string {
  const d = h.date ?? new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const tags: [string, string][] = [
    ["Event", h.event ?? "ChessLAN game"],
    ["Site", "ChessLAN"],
    ["Date", `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`],
    ["White", h.white],
    ["Black", h.black],
    ["Result", h.result ?? "*"],
  ];
  if (h.timeControl) tags.push(["TimeControl", h.timeControl]);
  if (h.termination) tags.push(["Termination", h.termination]);
  const header = tags.map(([k, v]) => `[${k} "${v.replace(/"/g, "'")}"]`).join("\n");

  const tokens: string[] = [];
  moves.forEach((m, i) => {
    if (m.color === "w") tokens.push(`${Math.floor(i / 2) + 1}.`);
    else if (i === 0) tokens.push("1...");
    tokens.push(m.san);
  });
  tokens.push(h.result ?? "*");
  const lines: string[] = [];
  let line = "";
  for (const t of tokens) {
    if (line && line.length + 1 + t.length > 80) {
      lines.push(line);
      line = t;
    } else {
      line = line ? `${line} ${t}` : t;
    }
  }
  if (line) lines.push(line);
  return `${header}\n\n${lines.join("\n")}\n`;
}

