// Fast chess position on a 0x88 board with incremental Zobrist hashing.
// Used by the game rules (hub + UI) and by the bot's search, so moves are
// plain integers and make/unmake allocate nothing.

export const WHITE = 0;
export const BLACK = 1;
export type Color = 0 | 1;

export const EMPTY = 0;
export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

// A piece code is (color << 3) | type; 0 is an empty square.
export const pieceColor = (p: number): Color => (p >> 3) as Color;
export const pieceType = (p: number): number => p & 7;
export const makePiece = (color: Color, type: number): number => (color << 3) | type;

// Move flags.
export const F_CAPTURE = 1;
export const F_DOUBLE = 2;
export const F_EP = 4;
export const F_CASTLE = 8;
export const F_PROMO = 16;

// A move packs from (7 bits, 0x88) | to << 7 | promotion type << 14 | flags << 17.
export const moveFrom = (m: number): number => m & 0x7f;
export const moveTo = (m: number): number => (m >> 7) & 0x7f;
export const movePromo = (m: number): number => (m >> 14) & 7;
export const moveFlags = (m: number): number => m >> 17;
const encode = (from: number, to: number, promo: number, flags: number): number =>
  from | (to << 7) | (promo << 14) | (flags << 17);

// Castling rights bits.
const WK = 1;
const WQ = 2;
const BK = 4;
const BQ = 8;

export const sq88 = (index64: number): number => ((index64 >> 3) << 4) | (index64 & 7);
export const sq64 = (s88: number): number => ((s88 >> 4) << 3) | (s88 & 7);
export const squareName = (s88: number): string =>
  String.fromCharCode(97 + (s88 & 7)) + String.fromCharCode(49 + (s88 >> 4));
export const parseSquare = (name: string): number => {
  const f = name.charCodeAt(0) - 97;
  const r = name.charCodeAt(1) - 49;
  if (f < 0 || f > 7 || r < 0 || r > 7 || name.length !== 2) return -1;
  return (r << 4) | f;
};

const KNIGHT_D = [33, 31, 18, 14, -33, -31, -18, -14];
const BISHOP_D = [17, 15, -17, -15];
const ROOK_D = [16, -16, 1, -1];
const KING_D = [17, 15, -17, -15, 16, -16, 1, -1];
const PAWN_CAPTURE_D = [
  [15, 17],
  [-15, -17],
];

// Castling-rights mask applied when a move touches a square.
const CASTLE_MASK = new Uint8Array(128).fill(15);
CASTLE_MASK[0x00] = 15 & ~WQ;
CASTLE_MASK[0x07] = 15 & ~WK;
CASTLE_MASK[0x04] = 15 & ~(WK | WQ);
CASTLE_MASK[0x70] = 15 & ~BQ;
CASTLE_MASK[0x77] = 15 & ~BK;
CASTLE_MASK[0x74] = 15 & ~(BK | BQ);

// Zobrist keys as pairs of 32-bit halves (deterministic PRNG).
let seed = 0x9e3779b9;
const rand32 = (): number => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
};
const Z_PIECE_LO = new Uint32Array(16 * 128);
const Z_PIECE_HI = new Uint32Array(16 * 128);
for (let i = 0; i < Z_PIECE_LO.length; i++) {
  Z_PIECE_LO[i] = rand32();
  Z_PIECE_HI[i] = rand32();
}
const Z_CASTLE_LO = Uint32Array.from({ length: 16 }, rand32);
const Z_CASTLE_HI = Uint32Array.from({ length: 16 }, rand32);
const Z_EP_LO = Uint32Array.from({ length: 8 }, rand32);
const Z_EP_HI = Uint32Array.from({ length: 8 }, rand32);
const Z_TURN_LO = rand32();
const Z_TURN_HI = rand32();

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const INITIAL_PLIES = 512;

export class Position {
  board = new Int8Array(128);
  turn: Color = WHITE;
  castling = 0;
  ep = -1; // en-passant target square (0x88) or -1
  halfmove = 0;
  fullmove = 1;
  kings = new Int16Array(2);
  hashLo = 0;
  hashHi = 0;

  // Undo stack (parallel typed arrays, indexed by ply; grown on demand).
  ply = 0;
  private uMove = new Int32Array(INITIAL_PLIES);
  private uCaptured = new Int8Array(INITIAL_PLIES);
  private uCastling = new Int8Array(INITIAL_PLIES);
  private uEp = new Int16Array(INITIAL_PLIES);
  private uHalf = new Int16Array(INITIAL_PLIES);
  private uHashLo = new Uint32Array(INITIAL_PLIES);
  private uHashHi = new Uint32Array(INITIAL_PLIES);
  // Hash of the position before each ply plus the current one, for repetition.
  private histLo = new Uint32Array(INITIAL_PLIES + 1);
  private histHi = new Uint32Array(INITIAL_PLIES + 1);

  static fromFen(fen: string = START_FEN): Position {
    const p = new Position();
    p.loadFen(fen);
    return p;
  }

  /** Doubles the undo stack when the next ply wouldn't fit (very long games). */
  private reserve(): void {
    if (this.ply + 1 < this.uMove.length) return;
    const grow = <T extends Int8Array | Int16Array | Int32Array | Uint32Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(a.length * 2);
      b.set(a);
      return b;
    };
    this.uMove = grow(this.uMove);
    this.uCaptured = grow(this.uCaptured);
    this.uCastling = grow(this.uCastling);
    this.uEp = grow(this.uEp);
    this.uHalf = grow(this.uHalf);
    this.uHashLo = grow(this.uHashLo);
    this.uHashHi = grow(this.uHashHi);
    this.histLo = grow(this.histLo);
    this.histHi = grow(this.histHi);
  }

  loadFen(fen: string): void {
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 4) throw new Error(`Bad FEN: ${fen}`);
    this.board.fill(0);
    const kingCount = [0, 0];
    const rows = parts[0].split("/");
    if (rows.length !== 8) throw new Error(`Bad FEN board: ${fen}`);
    for (let r = 0; r < 8; r++) {
      let f = 0;
      for (const ch of rows[r]) {
        if (ch >= "1" && ch <= "8") {
          f += Number(ch);
          continue;
        }
        const type = "pnbrqk".indexOf(ch.toLowerCase()) + 1;
        if (type === 0 || f > 7) throw new Error(`Bad FEN piece: ${fen}`);
        const color: Color = ch === ch.toLowerCase() ? BLACK : WHITE;
        const s = ((7 - r) << 4) | f;
        this.board[s] = makePiece(color, type);
        if (type === KING) {
          this.kings[color] = s;
          kingCount[color]++;
        }
        f++;
      }
    }
    if (kingCount[WHITE] !== 1 || kingCount[BLACK] !== 1) throw new Error(`FEN needs one king per side: ${fen}`);
    this.turn = parts[1] === "b" ? BLACK : WHITE;
    this.castling = 0;
    if (parts[2].includes("K")) this.castling |= WK;
    if (parts[2].includes("Q")) this.castling |= WQ;
    if (parts[2].includes("k")) this.castling |= BK;
    if (parts[2].includes("q")) this.castling |= BQ;
    this.ep = parts[3] === "-" ? -1 : parseSquare(parts[3]);
    this.halfmove = Number(parts[4] ?? 0) || 0;
    this.fullmove = Number(parts[5] ?? 1) || 1;
    this.ply = 0;
    this.computeHash();
    this.histLo[0] = this.hashLo;
    this.histHi[0] = this.hashHi;
  }

  fen(): string {
    let out = "";
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.board[(r << 4) | f];
        if (!p) {
          empty++;
          continue;
        }
        if (empty) {
          out += empty;
          empty = 0;
        }
        const ch = " pnbrqk"[pieceType(p)];
        out += pieceColor(p) === WHITE ? ch.toUpperCase() : ch;
      }
      if (empty) out += empty;
      if (r) out += "/";
    }
    let c = "";
    if (this.castling & WK) c += "K";
    if (this.castling & WQ) c += "Q";
    if (this.castling & BK) c += "k";
    if (this.castling & BQ) c += "q";
    return `${out} ${this.turn === WHITE ? "w" : "b"} ${c || "-"} ${
      this.ep >= 0 ? squareName(this.ep) : "-"
    } ${this.halfmove} ${this.fullmove}`;
  }

  // The en-passant square only counts for hashing/repetition when the side
  // to move can legally capture there (FIDE: otherwise the positions are the
  // same). The capture is tried directly on the board, without makeMove.
  private epMatters(): boolean {
    if (this.ep < 0) return false;
    const b = this.board;
    const us = this.turn;
    const pawn = makePiece(us, PAWN);
    const victimSq = us === WHITE ? this.ep - 16 : this.ep + 16;
    const victim = b[victimSq];
    for (const d of PAWN_CAPTURE_D[us]) {
      const from = this.ep - d;
      if (from & 0x88 || b[from] !== pawn) continue;
      b[from] = 0;
      b[victimSq] = 0;
      b[this.ep] = pawn;
      const legal = !this.isAttacked(this.kings[us], (us ^ 1) as Color);
      b[this.ep] = 0;
      b[victimSq] = victim;
      b[from] = pawn;
      if (legal) return true;
    }
    return false;
  }

  private computeHash(): void {
    let lo = 0;
    let hi = 0;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) continue;
      const p = this.board[s];
      if (p) {
        lo ^= Z_PIECE_LO[(p << 7) | s];
        hi ^= Z_PIECE_HI[(p << 7) | s];
      }
    }
    lo ^= Z_CASTLE_LO[this.castling];
    hi ^= Z_CASTLE_HI[this.castling];
    if (this.epMatters()) {
      lo ^= Z_EP_LO[this.ep & 7];
      hi ^= Z_EP_HI[this.ep & 7];
    }
    if (this.turn === BLACK) {
      lo ^= Z_TURN_LO;
      hi ^= Z_TURN_HI;
    }
    this.hashLo = lo >>> 0;
    this.hashHi = hi >>> 0;
  }

  isAttacked(s: number, by: Color): boolean {
    const b = this.board;
    // Pawns
    if (by === WHITE) {
      if (!((s - 15) & 0x88) && b[s - 15] === makePiece(WHITE, PAWN)) return true;
      if (!((s - 17) & 0x88) && b[s - 17] === makePiece(WHITE, PAWN)) return true;
    } else {
      if (!((s + 15) & 0x88) && b[s + 15] === makePiece(BLACK, PAWN)) return true;
      if (!((s + 17) & 0x88) && b[s + 17] === makePiece(BLACK, PAWN)) return true;
    }
    const knight = makePiece(by, KNIGHT);
    for (let i = 0; i < 8; i++) {
      const t = s + KNIGHT_D[i];
      if (!(t & 0x88) && b[t] === knight) return true;
    }
    const king = makePiece(by, KING);
    for (let i = 0; i < 8; i++) {
      const t = s + KING_D[i];
      if (!(t & 0x88) && b[t] === king) return true;
    }
    const bishop = makePiece(by, BISHOP);
    const rook = makePiece(by, ROOK);
    const queen = makePiece(by, QUEEN);
    for (let i = 0; i < 4; i++) {
      const d = BISHOP_D[i];
      for (let t = s + d; !(t & 0x88); t += d) {
        const p = b[t];
        if (p) {
          if (p === bishop || p === queen) return true;
          break;
        }
      }
    }
    for (let i = 0; i < 4; i++) {
      const d = ROOK_D[i];
      for (let t = s + d; !(t & 0x88); t += d) {
        const p = b[t];
        if (p) {
          if (p === rook || p === queen) return true;
          break;
        }
      }
    }
    return false;
  }

  inCheck(color: Color = this.turn): boolean {
    return this.isAttacked(this.kings[color], (color ^ 1) as Color);
  }

  // Appends pseudo-legal moves to `out` and returns it. With capturesOnly,
  // only captures and promotions are generated (for quiescence search).
  generatePseudo(out: number[] = [], capturesOnly = false): number[] {
    const b = this.board;
    const us = this.turn;
    const them = (us ^ 1) as Color;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) {
        s += 7;
        continue;
      }
      const p = b[s];
      if (!p || pieceColor(p) !== us) continue;
      const type = pieceType(p);
      if (type === PAWN) {
        const dir = us === WHITE ? 16 : -16;
        const startRank = us === WHITE ? 1 : 6;
        const promoRank = us === WHITE ? 7 : 0;
        const one = s + dir;
        if (!(one & 0x88) && !b[one]) {
          if (one >> 4 === promoRank) {
            for (let pt = QUEEN; pt >= KNIGHT; pt--) out.push(encode(s, one, pt, F_PROMO));
          } else if (!capturesOnly) {
            out.push(encode(s, one, 0, 0));
            const two = one + dir;
            if (s >> 4 === startRank && !b[two]) out.push(encode(s, two, 0, F_DOUBLE));
          }
        }
        for (const cd of PAWN_CAPTURE_D[us]) {
          const t = s + cd;
          if (t & 0x88) continue;
          const target = b[t];
          if (target && pieceColor(target) === them) {
            if (t >> 4 === promoRank) {
              for (let pt = QUEEN; pt >= KNIGHT; pt--) out.push(encode(s, t, pt, F_CAPTURE | F_PROMO));
            } else {
              out.push(encode(s, t, 0, F_CAPTURE));
            }
          } else if (t === this.ep) {
            out.push(encode(s, t, 0, F_CAPTURE | F_EP));
          }
        }
        continue;
      }
      if (type === KNIGHT || type === KING) {
        const deltas = type === KNIGHT ? KNIGHT_D : KING_D;
        for (let i = 0; i < 8; i++) {
          const t = s + deltas[i];
          if (t & 0x88) continue;
          const target = b[t];
          if (!target) {
            if (!capturesOnly) out.push(encode(s, t, 0, 0));
          } else if (pieceColor(target) === them) {
            out.push(encode(s, t, 0, F_CAPTURE));
          }
        }
        if (type === KING && !capturesOnly) this.generateCastles(s, out);
        continue;
      }
      const deltas = type === BISHOP ? BISHOP_D : type === ROOK ? ROOK_D : KING_D;
      for (let i = 0; i < deltas.length; i++) {
        const d = deltas[i];
        for (let t = s + d; !(t & 0x88); t += d) {
          const target = b[t];
          if (!target) {
            if (!capturesOnly) out.push(encode(s, t, 0, 0));
            continue;
          }
          if (pieceColor(target) === them) out.push(encode(s, t, 0, F_CAPTURE));
          break;
        }
      }
    }
    return out;
  }

  private generateCastles(kingSq: number, out: number[]): void {
    const b = this.board;
    const us = this.turn;
    const them = (us ^ 1) as Color;
    const home = us === WHITE ? 0x04 : 0x74;
    if (kingSq !== home) return;
    const kRight = us === WHITE ? WK : BK;
    const qRight = us === WHITE ? WQ : BQ;
    const rook = makePiece(us, ROOK);
    if (
      this.castling & kRight &&
      !b[home + 1] &&
      !b[home + 2] &&
      b[home + 3] === rook &&
      !this.isAttacked(home, them) &&
      !this.isAttacked(home + 1, them) &&
      !this.isAttacked(home + 2, them)
    ) {
      out.push(encode(home, home + 2, 0, F_CASTLE));
    }
    if (
      this.castling & qRight &&
      !b[home - 1] &&
      !b[home - 2] &&
      !b[home - 3] &&
      b[home - 4] === rook &&
      !this.isAttacked(home, them) &&
      !this.isAttacked(home - 1, them) &&
      !this.isAttacked(home - 2, them)
    ) {
      out.push(encode(home, home - 2, 0, F_CASTLE));
    }
  }

  generateLegal(): number[] {
    const pseudo = this.generatePseudo();
    const legal: number[] = [];
    for (const m of pseudo) {
      if (this.makeMove(m)) {
        this.unmakeMove();
        legal.push(m);
      }
    }
    return legal;
  }

  hasLegalMove(): boolean {
    const pseudo = this.generatePseudo();
    for (const m of pseudo) {
      if (this.makeMove(m)) {
        this.unmakeMove();
        return true;
      }
    }
    return false;
  }

  private xorPiece(p: number, s: number): void {
    this.hashLo ^= Z_PIECE_LO[(p << 7) | s];
    this.hashHi ^= Z_PIECE_HI[(p << 7) | s];
  }

  // Plays a pseudo-legal move. Returns false (and restores the position) if
  // it would leave the mover's king in check.
  makeMove(m: number): boolean {
    this.reserve();
    const b = this.board;
    const from = moveFrom(m);
    const to = moveTo(m);
    const flags = moveFlags(m);
    const us = this.turn;
    const piece = b[from];
    const ply = this.ply;

    this.uMove[ply] = m;
    this.uCastling[ply] = this.castling;
    this.uEp[ply] = this.ep;
    this.uHalf[ply] = this.halfmove;
    this.uHashLo[ply] = this.hashLo;
    this.uHashHi[ply] = this.hashHi;

    // Remove old ep and castling from hash.
    if (this.epMatters()) {
      this.hashLo ^= Z_EP_LO[this.ep & 7];
      this.hashHi ^= Z_EP_HI[this.ep & 7];
    }
    this.hashLo ^= Z_CASTLE_LO[this.castling];
    this.hashHi ^= Z_CASTLE_HI[this.castling];

    let captured = 0;
    if (flags & F_EP) {
      const capSq = us === WHITE ? to - 16 : to + 16;
      captured = b[capSq];
      b[capSq] = 0;
      this.xorPiece(captured, capSq);
    } else if (b[to]) {
      captured = b[to];
      this.xorPiece(captured, to);
    }
    this.uCaptured[ply] = captured;

    b[to] = piece;
    b[from] = 0;
    this.xorPiece(piece, from);
    const promo = movePromo(m);
    if (promo) {
      b[to] = makePiece(us, promo);
      this.xorPiece(b[to], to);
    } else {
      this.xorPiece(piece, to);
    }

    if (flags & F_CASTLE) {
      const rookFrom = to > from ? to + 1 : to - 2;
      const rookTo = to > from ? to - 1 : to + 1;
      const rook = b[rookFrom];
      b[rookTo] = rook;
      b[rookFrom] = 0;
      this.xorPiece(rook, rookFrom);
      this.xorPiece(rook, rookTo);
    }

    if (pieceType(piece) === KING) this.kings[us] = to;

    this.castling &= CASTLE_MASK[from] & CASTLE_MASK[to];
    this.ep = flags & F_DOUBLE ? (from + to) >> 1 : -1;
    this.halfmove = pieceType(piece) === PAWN || captured ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove++;
    this.turn = (us ^ 1) as Color;
    this.hashLo ^= Z_TURN_LO;
    this.hashHi ^= Z_TURN_HI;
    this.hashLo ^= Z_CASTLE_LO[this.castling];
    this.hashHi ^= Z_CASTLE_HI[this.castling];
    if (this.epMatters()) {
      this.hashLo ^= Z_EP_LO[this.ep & 7];
      this.hashHi ^= Z_EP_HI[this.ep & 7];
    }
    this.hashLo >>>= 0;
    this.hashHi >>>= 0;

    this.ply = ply + 1;
    this.histLo[this.ply] = this.hashLo;
    this.histHi[this.ply] = this.hashHi;

    if (this.isAttacked(this.kings[us], this.turn)) {
      this.unmakeMove();
      return false;
    }
    return true;
  }

  unmakeMove(): void {
    const ply = --this.ply;
    const m = this.uMove[ply];
    const b = this.board;
    const from = moveFrom(m);
    const to = moveTo(m);
    const flags = moveFlags(m);
    this.turn = (this.turn ^ 1) as Color;
    const us = this.turn;
    let piece = b[to];
    if (movePromo(m)) piece = makePiece(us, PAWN);
    b[from] = piece;
    b[to] = 0;
    const captured = this.uCaptured[ply];
    if (flags & F_EP) {
      b[us === WHITE ? to - 16 : to + 16] = captured;
    } else {
      b[to] = captured;
    }
    if (flags & F_CASTLE) {
      const rookFrom = to > from ? to + 1 : to - 2;
      const rookTo = to > from ? to - 1 : to + 1;
      b[rookFrom] = b[rookTo];
      b[rookTo] = 0;
    }
    if (pieceType(piece) === KING) this.kings[us] = from;
    if (us === BLACK) this.fullmove--;
    this.castling = this.uCastling[ply];
    this.ep = this.uEp[ply];
    this.halfmove = this.uHalf[ply];
    this.hashLo = this.uHashLo[ply];
    this.hashHi = this.uHashHi[ply];
  }

  // Null move for search (side to move passes). Never call when in check.
  makeNullMove(): void {
    this.reserve();
    const ply = this.ply;
    this.uMove[ply] = 0;
    this.uCaptured[ply] = 0;
    this.uCastling[ply] = this.castling;
    this.uEp[ply] = this.ep;
    this.uHalf[ply] = this.halfmove;
    this.uHashLo[ply] = this.hashLo;
    this.uHashHi[ply] = this.hashHi;
    if (this.epMatters()) {
      this.hashLo ^= Z_EP_LO[this.ep & 7];
      this.hashHi ^= Z_EP_HI[this.ep & 7];
    }
    this.ep = -1;
    this.turn = (this.turn ^ 1) as Color;
    this.hashLo = (this.hashLo ^ Z_TURN_LO) >>> 0;
    this.hashHi = (this.hashHi ^ Z_TURN_HI) >>> 0;
    this.halfmove++;
    this.ply = ply + 1;
    this.histLo[this.ply] = this.hashLo;
    this.histHi[this.ply] = this.hashHi;
  }

  unmakeNullMove(): void {
    const ply = --this.ply;
    this.turn = (this.turn ^ 1) as Color;
    this.castling = this.uCastling[ply];
    this.ep = this.uEp[ply];
    this.halfmove = this.uHalf[ply];
    this.hashLo = this.uHashLo[ply];
    this.hashHi = this.uHashHi[ply];
  }

  // How many times the current position has occurred (including now),
  // looking back only as far as the last irreversible move.
  repetitions(): number {
    let count = 1;
    const lo = this.hashLo;
    const hi = this.hashHi;
    const limit = Math.max(0, this.ply - this.halfmove);
    for (let i = this.ply - 2; i >= limit; i -= 2) {
      if (this.histLo[i] === lo && this.histHi[i] === hi) count++;
    }
    return count;
  }

  // Dead-position approximation used by chess.com and FIDE arbiters:
  // K v K, K+minor v K, and bishops-only all on one square colour.
  insufficientMaterial(): boolean {
    let minors = 0;
    let knights = 0;
    let lightBishops = 0;
    let darkBishops = 0;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) continue;
      const t = pieceType(this.board[s]);
      if (t === PAWN || t === ROOK || t === QUEEN) return false;
      if (t === KNIGHT) {
        knights++;
        minors++;
      } else if (t === BISHOP) {
        minors++;
        if (((s >> 4) + (s & 7)) % 2) lightBishops++;
        else darkBishops++;
      }
    }
    if (minors <= 1) return true;
    return knights === 0 && (lightBishops === 0 || darkBishops === 0);
  }

  // True if `color` has no way to ever deliver mate on its own: a lone king,
  // or king plus a single minor piece. Used for "timeout vs insufficient".
  cannotWin(color: Color): boolean {
    let minors = 0;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) continue;
      const p = this.board[s];
      if (!p || pieceColor(p) !== color) continue;
      const t = pieceType(p);
      if (t === KING) continue;
      if (t === KNIGHT || t === BISHOP) minors++;
      else return false;
    }
    return minors <= 1;
  }
}

export const moveToUci = (m: number): string =>
  squareName(moveFrom(m)) + squareName(moveTo(m)) + (movePromo(m) ? " pnbrqk"[movePromo(m)] : "");

export function perft(pos: Position, depth: number): number {
  if (depth === 0) return 1;
  const moves = pos.generatePseudo();
  let nodes = 0;
  for (const m of moves) {
    if (!pos.makeMove(m)) continue;
    nodes += depth === 1 ? 1 : perft(pos, depth - 1);
    pos.unmakeMove();
  }
  return nodes;
}
