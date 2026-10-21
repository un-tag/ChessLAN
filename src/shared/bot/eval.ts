// Static evaluation for the bot: tapered PeSTO piece-square tables plus a few
// cheap terms (bishop pair, pawn structure, open files, pawn shield,
// mobility, king tropism). A style re-weights one side only (the bot's), so
// personalities change what the bot likes without touching the search.
import { BISHOP, KING, KNIGHT, PAWN, QUEEN, ROOK, WHITE, makePiece, type Color, type Position } from "../chess/position";

export interface EvalStyle {
  /** Own pawns: extra middlegame cp per rank advanced. */
  pawnAdvance?: number;
  /** Scale on own pieces' closeness to the enemy king (default 1). */
  attack?: number;
  /** Scale on own king's pawn shield (default 1). */
  kingShield?: number;
  /** Own queen: middlegame cp for leaving its home rank; also doubles its mobility. */
  queenSortie?: number;
  /** Own knights: flat cp bonus. */
  knightLove?: number;
  /** Scale on own mobility (default 1). */
  mobility?: number;
  /** Own side: cp per pawn's worth of non-pawn material traded off the board. */
  trades?: number;
  /** Scale on all piece values, both sides (default 1). Below 1 = loose with material. */
  material?: number;
}

const MG_VALUE = [0, 82, 337, 365, 477, 1025, 0];
const EG_VALUE = [0, 94, 281, 297, 512, 936, 0];
// Round values for non-pawn material counts (trades, null move, draw scaling).
const NPM_VALUE = [0, 0, 300, 300, 500, 900, 0];
const NPM_START = 2 * (2 * 300 + 2 * 300 + 2 * 500 + 900);
const PHASE_INC = [0, 0, 1, 1, 2, 4, 0];
const TEMPO = 10;

// PeSTO tables (Rofchade), a8..h8 first, from White's point of view.
// prettier-ignore
const MG_PST: number[][] = [
  [],
  [
      0,   0,   0,   0,   0,   0,   0,   0,
     98, 134,  61,  95,  68, 126,  34, -11,
     -6,   7,  26,  31,  65,  56,  25, -20,
    -14,  13,   6,  21,  23,  12,  17, -23,
    -27,  -2,  -5,  12,  17,   6,  10, -25,
    -26,  -4,  -4, -10,   3,   3,  33, -12,
    -35,  -1, -20, -23, -15,  24,  38, -22,
      0,   0,   0,   0,   0,   0,   0,   0,
  ],
  [
   -167, -89, -34, -49,  61, -97, -15, -107,
    -73, -41,  72,  36,  23,  62,   7,  -17,
    -47,  60,  37,  65,  84, 129,  73,   44,
     -9,  17,  19,  53,  37,  69,  18,   22,
    -13,   4,  16,  13,  28,  19,  21,   -8,
    -23,  -9,  12,  10,  19,  17,  25,  -16,
    -29, -53, -12,  -3,  -1,  18, -14,  -19,
   -105, -21, -58, -33, -17, -28, -19,  -23,
  ],
  [
    -29,   4, -82, -37, -25, -42,   7,  -8,
    -26,  16, -18, -13,  30,  59,  18, -47,
    -16,  37,  43,  40,  35,  50,  37,  -2,
     -4,   5,  19,  50,  37,  37,   7,  -2,
     -6,  13,  13,  26,  34,  12,  10,   4,
      0,  15,  15,  15,  14,  27,  18,  10,
      4,  15,  16,   0,   7,  21,  33,   1,
    -33,  -3, -14, -21, -13, -12, -39, -21,
  ],
  [
     32,  42,  32,  51,  63,   9,  31,  43,
     27,  32,  58,  62,  80,  67,  26,  44,
     -5,  19,  26,  36,  17,  45,  61,  16,
    -24, -11,   7,  26,  24,  35,  -8, -20,
    -36, -26, -12,  -1,   9,  -7,   6, -23,
    -45, -25, -16, -17,   3,   0,  -5, -33,
    -44, -16, -20,  -9,  -1,  11,  -6, -71,
    -19, -13,   1,  17,  16,   7, -37, -26,
  ],
  [
    -28,   0,  29,  12,  59,  44,  43,  45,
    -24, -39,  -5,   1, -16,  57,  28,  54,
    -13, -17,   7,   8,  29,  56,  47,  57,
    -27, -27, -16, -16,  -1,  17,  -2,   1,
     -9, -26,  -9, -10,  -2,  -4,   3,  -3,
    -14,   2, -11,  -2,  -5,   2,  14,   5,
    -35,  -8,  11,   2,   8,  15,  -3,   1,
     -1, -18,  -9,  10, -15, -25, -31, -50,
  ],
  [
    -65,  23,  16, -15, -56, -34,   2,  13,
     29,  -1, -20,  -7,  -8,  -4, -38, -29,
     -9,  24,   2, -16, -20,   6,  22, -22,
    -17, -20, -12, -27, -30, -25, -14, -36,
    -49,  -1, -27, -39, -46, -44, -33, -51,
    -14, -14, -22, -46, -44, -30, -15, -27,
      1,   7,  -8, -64, -43, -16,   9,   8,
    -15,  36,  12, -54,   8, -28,  24,  14,
  ],
];

// prettier-ignore
const EG_PST: number[][] = [
  [],
  [
      0,   0,   0,   0,   0,   0,   0,   0,
    178, 173, 158, 134, 147, 132, 165, 187,
     94, 100,  85,  67,  56,  53,  82,  84,
     32,  24,  13,   5,  -2,   4,  17,  17,
     13,   9,  -3,  -7,  -7,  -8,   3,  -1,
      4,   7,  -6,   1,   0,  -5,  -1,  -8,
     13,   8,   8,  10,  13,   0,   2,  -7,
      0,   0,   0,   0,   0,   0,   0,   0,
  ],
  [
    -58, -38, -13, -28, -31, -27, -63, -99,
    -25,  -8, -25,  -2,  -9, -25, -24, -52,
    -24, -20,  10,   9,  -1,  -9, -19, -41,
    -17,   3,  22,  22,  22,  11,   8, -18,
    -18,  -6,  16,  25,  16,  17,   4, -18,
    -23,  -3,  -1,  15,  10,  -3, -20, -22,
    -42, -20, -10,  -5,  -2, -20, -23, -44,
    -29, -51, -23, -15, -22, -18, -50, -64,
  ],
  [
    -14, -21, -11,  -8,  -7,  -9, -17, -24,
     -8,  -4,   7, -12,  -3, -13,  -4, -14,
      2,  -8,   0,  -1,  -2,   6,   0,   4,
     -3,   9,  12,   9,  14,  10,   3,   2,
     -6,   3,  13,  19,   7,  10,  -3,  -9,
    -12,  -3,   8,  10,  13,   3,  -7, -15,
    -14, -18,  -7,  -1,   4,  -9, -15, -27,
    -23,  -9, -23,  -5,  -9, -16,  -5, -17,
  ],
  [
     13,  10,  18,  15,  12,  12,   8,   5,
     11,  13,  13,  11,  -3,   3,   8,   3,
      7,   7,   7,   5,   4,  -3,  -5,  -3,
      4,   3,  13,   1,   2,   1,  -1,   2,
      3,   5,   8,   4,  -5,  -6,  -8, -11,
     -4,   0,  -5,  -1,  -7, -12,  -8, -16,
     -6,  -6,   0,   2,  -9,  -9, -11,  -3,
     -9,   2,   3,  -1,  -5, -13,   4, -20,
  ],
  [
     -9,  22,  22,  27,  27,  19,  10,  20,
    -17,  20,  32,  41,  58,  25,  30,   0,
    -20,   6,   9,  49,  47,  35,  19,   9,
      3,  22,  24,  45,  57,  40,  57,  36,
    -18,  28,  19,  47,  31,  34,  39,  23,
    -16, -27,  15,   6,   9,  17,  10,   5,
    -22, -23, -30, -16, -16, -23, -36, -32,
    -33, -28, -22, -43,  -5, -32, -20, -41,
  ],
  [
    -74, -35, -18, -18, -11,  15,   4, -17,
    -12,  17,  14,  17,  17,  38,  23,  11,
     10,  17,  23,  15,  20,  45,  44,  13,
     -8,  22,  24,  27,  26,  33,  26,   3,
    -18,  -4,  21,  24,  27,  23,   9, -11,
    -19,  -3,  11,  21,  23,  16,   7,  -9,
    -27, -11,   4,  13,  14,   4,  -5, -17,
    -53, -34, -21, -11, -28, -14, -24, -43,
  ],
];

// Mobility: weight per reachable square above a baseline, by piece type.
const MOB_BASE = [0, 0, 4, 6, 6, 12, 0];
const MOB_MG = [0, 0, 4, 5, 2, 1, 0];
const MOB_EG = [0, 0, 4, 5, 4, 2, 0];
// Middlegame cp per step closer to the enemy king (7 - distance).
const TROPISM = [0, 0, 2, 1, 1, 3, 0];
// Passed pawn bonus by relative rank.
const PASSED_MG = [0, 0, 5, 10, 20, 35, 55, 0];
const PASSED_EG = [0, 5, 10, 20, 35, 60, 100, 0];

const KNIGHT_D = [33, 31, 18, 14, -33, -31, -18, -14];
const BISHOP_D = [17, 15, -17, -15];
const ROOK_D = [16, -16, 1, -1];
const QUEEN_D = [17, 15, -17, -15, 16, -16, 1, -1];

// Chebyshev distance between 0x88 squares, and distance from the centre.
const DIST = new Uint8Array(128 * 128);
const CENTER_DIST = new Uint8Array(128);
for (let a = 0; a < 128; a++) {
  if (a & 0x88) continue;
  const af = a & 7;
  const ar = a >> 4;
  CENTER_DIST[a] = Math.max(3 - af, af - 4) + Math.max(3 - ar, ar - 4);
  for (let b = 0; b < 128; b++) {
    if (b & 0x88) continue;
    DIST[(a << 7) | b] = Math.max(Math.abs(af - (b & 7)), Math.abs(ar - (b >> 4)));
  }
}

// Bit tricks on 8-bit rank masks: population count, highest and lowest bit.
const POP8 = new Uint8Array(256);
const HIGH8 = new Uint8Array(256);
const LOW8 = new Uint8Array(256);
for (let m = 1; m < 256; m++) {
  POP8[m] = POP8[m >> 1] + (m & 1);
  HIGH8[m] = 31 - Math.clz32(m);
  LOW8[m] = 31 - Math.clz32(m & -m);
}

// Mop-up scratch: flood-fill queue and seen marks.
const QUEUE = new Int16Array(64);
const SEEN = new Uint8Array(128);

// Bonus for the side mating a lone king: the area the king can still reach
// without crossing attacked squares (the "box"), its distance from the
// centre, and how close the kings are.
function mopUp(pos: Position, lone: number, winner: number): number {
  const by = (pos.board[winner] >> 3) as Color;
  SEEN.fill(0);
  SEEN[lone] = 1;
  QUEUE[0] = lone;
  let head = 0;
  let tail = 1;
  while (head < tail) {
    const s = QUEUE[head++];
    for (let d = 0; d < 8; d++) {
      const t = s + QUEEN_D[d];
      if (t & 0x88 || SEEN[t]) continue;
      SEEN[t] = 1;
      if (!pos.isAttacked(t, by)) QUEUE[tail++] = t;
    }
  }
  const gap = Math.abs((lone & 7) - (winner & 7)) + Math.abs((lone >> 4) - (winner >> 4));
  return 10 * (64 - tail) + 20 * CENTER_DIST[lone] + 10 * (14 - gap);
}

export class Evaluator {
  // Material + PST per piece code and square, from the owner's point of view.
  private readonly mgT = new Int16Array(16 * 128);
  private readonly egT = new Int16Array(16 * 128);
  // Per (color << 3 | type) weights, so a style can differ per side.
  private readonly mobMg = new Float64Array(16);
  private readonly mobEg = new Float64Array(16);
  private readonly trop = new Float64Array(16);
  private readonly shield = new Float64Array(2);
  private readonly tradeW = new Float64Array(2);
  // Scratch: pawn rank masks per (color << 3 | file), non-pawn piece squares.
  private readonly pf = new Uint8Array(16);
  private readonly list = new Int16Array(32);
  /** Non-pawn material (300/300/500/900 scale) per color at the last evaluate(). */
  readonly npm = new Int32Array(2);

  constructor(style: EvalStyle = {}, styleColor: Color = WHITE) {
    const mat = style.material ?? 1;
    for (let color = 0; color < 2; color++) {
      const own = color === styleColor;
      for (let t = PAWN; t <= KING; t++) {
        const k = (color << 3) | t;
        const mob = own ? (style.mobility ?? 1) : 1;
        const queenMob = own && t === QUEEN && (style.queenSortie ?? 0) > 0 ? 2 : 1;
        this.mobMg[k] = MOB_MG[t] * mob * queenMob;
        this.mobEg[k] = MOB_EG[t] * mob * queenMob;
        this.trop[k] = TROPISM[t] * (own ? (style.attack ?? 1) : 1);
        for (let s64 = 0; s64 < 64; s64++) {
          const r = s64 >> 3;
          const f = s64 & 7;
          const rr = color === WHITE ? r : 7 - r;
          const idx = (7 - rr) * 8 + f;
          let mg = Math.round(MG_VALUE[t] * mat) + MG_PST[t][idx];
          let eg = Math.round(EG_VALUE[t] * mat) + EG_PST[t][idx];
          if (own) {
            if (t === PAWN && rr > 1) mg += (style.pawnAdvance ?? 0) * (rr - 1);
            if (t === KNIGHT) {
              mg += style.knightLove ?? 0;
              eg += style.knightLove ?? 0;
            }
            if (t === QUEEN && rr > 0) mg += style.queenSortie ?? 0;
          }
          const i = (makePiece(color as Color, t) << 7) | (r << 4) | f;
          this.mgT[i] = mg;
          this.egT[i] = eg;
        }
      }
      this.shield[color] = own ? (style.kingShield ?? 1) : 1;
      this.tradeW[color] = own ? (style.trades ?? 0) : 0;
    }
  }

  /** Score in centipawns from the side to move's point of view. */
  evaluate(pos: Position): number {
    const b = pos.board;
    const mgT = this.mgT;
    const egT = this.egT;
    const pf = this.pf;
    const list = this.list;
    pf.fill(0);
    let mg0 = 0;
    let mg1 = 0;
    let eg0 = 0;
    let eg1 = 0;
    let phase = 0;
    let n = 0;
    let bishops0 = 0;
    let bishops1 = 0;
    let npm0 = 0;
    let npm1 = 0;
    let pawns0 = 0;
    let pawns1 = 0;

    for (let s = 0; s < 128; s++) {
      if (s & 0x88) {
        s += 7;
        continue;
      }
      const p = b[s];
      if (!p) continue;
      const t = p & 7;
      const i = (p << 7) | s;
      if (p < 8) {
        mg0 += mgT[i];
        eg0 += egT[i];
        if (t === PAWN) {
          pf[s & 7] |= 1 << (s >> 4);
          pawns0++;
          continue;
        }
        npm0 += NPM_VALUE[t];
        if (t === BISHOP) bishops0++;
      } else {
        mg1 += mgT[i];
        eg1 += egT[i];
        if (t === PAWN) {
          pf[8 | (s & 7)] |= 1 << (s >> 4);
          pawns1++;
          continue;
        }
        npm1 += NPM_VALUE[t];
        if (t === BISHOP) bishops1++;
      }
      phase += PHASE_INC[t];
      if (t !== KING) list[n++] = s;
    }

    const k0 = pos.kings[0];
    const k1 = pos.kings[1];

    // Pieces: mobility, king tropism, rooks on open files.
    for (let j = 0; j < n; j++) {
      const s = list[j];
      const p = b[s];
      const t = p & 7;
      const c = p >> 3;
      let mob = 0;
      if (t === KNIGHT) {
        for (let d = 0; d < 8; d++) {
          const to = s + KNIGHT_D[d];
          if (to & 0x88) continue;
          const q = b[to];
          if (!q || q >> 3 !== c) mob++;
        }
      } else {
        const dirs = t === BISHOP ? BISHOP_D : t === ROOK ? ROOK_D : QUEEN_D;
        for (let d = 0; d < dirs.length; d++) {
          const dd = dirs[d];
          for (let to = s + dd; !(to & 0x88); to += dd) {
            const q = b[to];
            if (!q) {
              mob++;
              continue;
            }
            if (q >> 3 !== c) mob++;
            break;
          }
        }
      }
      const k = (c << 3) | t;
      const extra = mob - MOB_BASE[t];
      let m = this.mobMg[k] * extra + this.trop[k] * (7 - DIST[(s << 7) | (c ? k0 : k1)]);
      let e = this.mobEg[k] * extra;
      if (t === ROOK) {
        const f = s & 7;
        if (!pf[(c << 3) | f]) {
          if (!pf[((c ^ 1) << 3) | f]) {
            m += 25;
            e += 10;
          } else {
            m += 12;
            e += 6;
          }
        }
      }
      if (c) {
        mg1 += m;
        eg1 += e;
      } else {
        mg0 += m;
        eg0 += e;
      }
    }

    // Pawn structure and king shield, per side.
    for (let c = 0; c < 2; c++) {
      const own = c << 3;
      const opp = own ^ 8;
      const ourK = c ? k1 : k0;
      const theirK = c ? k0 : k1;
      let m = 0;
      let e = 0;
      for (let f = 0; f < 8; f++) {
        const mask = pf[own | f];
        if (!mask) continue;
        const cnt = POP8[mask];
        if (cnt > 1) {
          m -= 10 * (cnt - 1);
          e -= 20 * (cnt - 1);
        }
        const adj = (f > 0 ? pf[own | (f - 1)] : 0) | (f < 7 ? pf[own | (f + 1)] : 0);
        if (!adj) {
          m -= 10 * cnt;
          e -= 14 * cnt;
        }
        // Only the front-most pawn of a file can be passed.
        const r = c ? LOW8[mask] : HIGH8[mask];
        const ahead = c ? (1 << r) - 1 : (0xff << (r + 1)) & 0xff;
        const enemy = pf[opp | f] | (f > 0 ? pf[opp | (f - 1)] : 0) | (f < 7 ? pf[opp | (f + 1)] : 0);
        if (!(enemy & ahead)) {
          const rr = c ? 7 - r : r;
          m += PASSED_MG[rr];
          e += PASSED_EG[rr];
          const front = ((c ? r - 1 : r + 1) << 4) | f;
          e += (DIST[(theirK << 7) | front] - DIST[(ourK << 7) | front]) * 2 * rr;
        }
      }

      const kf = ourK & 7;
      const kr = ourK >> 4;
      let sh = 0;
      if ((c ? 7 - kr : kr) <= 1) {
        const a1 = 1 << (c ? kr - 1 : kr + 1);
        const a2 = 1 << (c ? kr - 2 : kr + 2);
        for (let f = kf > 0 ? kf - 1 : 0; f <= kf + 1 && f < 8; f++) {
          const mask = pf[own | f];
          if (mask & a1) sh += 12;
          else if (mask & a2) sh += 6;
          else {
            sh -= 10;
            if (!mask) sh -= pf[opp | f] ? 8 : 16;
          }
        }
      } else {
        sh = -25;
      }
      m += sh * this.shield[c];

      const trade = (this.tradeW[c] * (NPM_START - npm0 - npm1)) / 100;
      if (c) {
        mg1 += m + trade;
        eg1 += e + trade;
      } else {
        mg0 += m + trade;
        eg0 += e + trade;
      }
    }

    if (bishops0 >= 2) {
      mg0 += 30;
      eg0 += 50;
    }
    if (bishops1 >= 2) {
      mg1 += 30;
      eg1 += 50;
    }

    // Mop-up against a lone king: box it in, push it to the edge, come closer.
    if (npm1 === 0 && pawns1 === 0 && npm0 >= 500) eg0 += mopUp(pos, k1, k0);
    if (npm0 === 0 && pawns0 === 0 && npm1 >= 500) eg1 += mopUp(pos, k0, k1);

    if (phase > 24) phase = 24;
    let score = ((mg0 - mg1) * phase + (eg0 - eg1) * (24 - phase)) / 24;
    // Drawish: the side ahead has no pawns and less than a rook extra.
    if (score > 0 ? pawns0 === 0 && npm0 - npm1 < 400 : pawns1 === 0 && npm1 - npm0 < 400) score /= 4;

    this.npm[0] = npm0;
    this.npm[1] = npm1;
    return ((pos.turn === WHITE ? score : -score) + TEMPO) | 0;
  }
}
