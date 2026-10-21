import { describe, expect, it } from "vitest";
import { Game } from "../chess/game";
import { Position, START_FEN, moveToUci } from "../chess/position";
import { ALL_BOTS, LEVEL_BOTS, PERSONALITIES, chooseMove, getBot, positionFrom, seededRandom, type BotConfig } from "./bots";
import { Engine } from "./engine";
import { Evaluator } from "./eval";

const bot = (id: string): BotConfig => {
  const b = getBot(id);
  if (!b) throw new Error(`no bot ${id}`);
  return b;
};

const legalUci = (fen: string, history: string[] = []): string[] =>
  positionFrom(fen, history).generateLegal().map(moveToUci);

const isMate = (pos: Position): boolean => pos.inCheck() && !pos.hasLegalMove();

function mateInOne(pos: Position): boolean {
  for (const m of pos.generateLegal()) {
    pos.makeMove(m);
    const mate = isMate(pos);
    pos.unmakeMove();
    if (mate) return true;
  }
  return false;
}

/** True if `uci` mates at once or every reply allows a mate in one. */
function forcesMateIn2(fen: string, uci: string): boolean {
  const pos = positionFrom(fen, [uci]);
  if (isMate(pos)) return true;
  const replies = pos.generateLegal();
  if (!replies.length) return false;
  return replies.every((r) => {
    pos.makeMove(r);
    const ok = mateInOne(pos);
    pos.unmakeMove();
    return ok;
  });
}

function mirrorFen(fen: string): string {
  const [board, turn, castling, ep, half, full] = fen.split(" ");
  const swap = (s: string): string => s.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  const flipped = swap(board.split("/").reverse().join("/"));
  const c = castling === "-" ? "-" : swap(castling).split("").sort().join("");
  const e = ep === "-" ? "-" : ep[0] + (9 - Number(ep[1]));
  return `${flipped} ${turn === "w" ? "b" : "w"} ${c} ${e} ${half} ${full}`;
}

const MATE_IN_1: [string, string][] = [
  ["6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1", "back rank (white)"],
  ["3r2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1", "back rank (black)"],
  ["r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4", "scholar's mate"],
];

const MATE_IN_2: [string, string][] = [
  ["r1b2k1r/ppp1bppp/8/1B1Q4/5q2/2P5/PPP2PPP/R3R1K1 w - - 1 1", "Qd8+ Bxd8 Re8#"],
  ["r1bq2rk/pp3pbp/2p1p1pQ/7P/3P4/2PB1N2/PP3PPR/2KR4 w - - 0 1", "Qxh7+ Kxh7 hxg6#"],
  ["5k2/6pp/p1qN4/1p1p4/3P4/2PKP2Q/PP3r2/3R4 b - - 0 1", "Qc4+ (black)"],
];

// A free queen, and the move that takes it.
const HANGING_QUEEN: [string, string][] = [
  ["rnb1kbnr/pppp1ppp/8/8/3q4/5N2/PPPPPPPP/RNBQKB1R w KQkq - 0 3", "f3d4"],
  ["rnbqkb1r/pppppppp/5n2/7Q/8/8/PPPP1PPP/RNB1KBNR b KQkq - 0 2", "f6h5"],
];

const LEGALITY: string[] = [
  START_FEN,
  "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
  "4k3/8/8/8/8/8/3q4/4K3 w - - 0 1", // in check
  "4k3/4r3/8/8/8/8/4B3/4K3 w - - 0 1", // pinned bishop
  "8/P6k/8/8/8/8/6K1/8 w - - 0 1", // promotion
  "8/8/8/8/8/k7/7p/1K6 b - - 0 1", // black promotion
  "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", // en passant
  "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1", // most queen moves stalemate
  "k7/8/1QK5/8/8/8/8/8 w - - 0 1", // stalemate traps
  "8/8/8/8/8/4k3/5p2/5K2 w - - 0 1", // lone king, one move
];

describe("evaluation", () => {
  it("is colour-symmetric", () => {
    const ev = new Evaluator();
    for (const fen of [...LEGALITY, ...MATE_IN_2.map((p) => p[0])]) {
      const a = ev.evaluate(Position.fromFen(fen));
      const b = ev.evaluate(Position.fromFen(mirrorFen(fen)));
      expect(b, fen).toBe(a);
    }
  });
});

describe("tactics at level 10", () => {
  const top = bot("level-10");
  for (const [fen, name] of MATE_IN_1) {
    it(`mates in 1: ${name}`, () => {
      const r = chooseMove(fen, [], top, { random: seededRandom(1), timeMs: 1000 });
      expect(isMate(positionFrom(fen, [r.uci]))).toBe(true);
      expect(r.mate).toBe(1);
    });
  }
  for (const [fen, name] of MATE_IN_2) {
    it(`mates in 2: ${name}`, () => {
      const r = chooseMove(fen, [], top, { random: seededRandom(1), timeMs: 1000 });
      expect(forcesMateIn2(fen, r.uci)).toBe(true);
      expect(r.mate).toBe(2);
    });
  }
});

describe("strength", () => {
  it("takes a hanging queen at levels 6-10", () => {
    for (let level = 6; level <= 10; level++) {
      for (const [fen, capture] of HANGING_QUEEN) {
        for (let seed = 1; seed <= 3; seed++) {
          const r = chooseMove(fen, [], bot(`level-${level}`), { random: seededRandom(seed), timeMs: 150 });
          expect(r.uci, `level ${level} seed ${seed}`).toBe(capture);
        }
      }
    }
  });

  it("level 1 often misses the best move, mates included", () => {
    const weak = bot("level-1");
    const positions: [string, (uci: string) => boolean][] = [
      ...HANGING_QUEEN.map(([fen, best]): [string, (u: string) => boolean] => [fen, (u) => u === best]),
      ...MATE_IN_1.map(([fen]): [string, (u: string) => boolean] => [fen, (u) => isMate(positionFrom(fen, [u]))]),
    ];
    let misses = 0;
    let mateMisses = 0;
    let total = 0;
    positions.forEach(([fen, isBest], i) => {
      for (let seed = 1; seed <= 30; seed++) {
        const r = chooseMove(fen, [], weak, { random: seededRandom(seed * 7919 + i) });
        expect(legalUci(fen)).toContain(r.uci);
        total++;
        if (!isBest(r.uci)) {
          misses++;
          if (i >= HANGING_QUEEN.length) mateMisses++;
        }
      }
    });
    expect(misses / total).toBeGreaterThan(0.3);
    expect(mateMisses).toBeGreaterThan(0);
  });

  it("level 8 clearly beats level 2", () => {
    const strong = bot("level-8");
    const weak = bot("level-2");
    const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
    let points = 0;
    const games = 20;
    for (let g = 0; g < games; g++) {
      const strongIsWhite = g % 2 === 0;
      const random = seededRandom(1000 + g);
      const game = new Game();
      let result = 0.5;
      for (let ply = 0; ply < 120; ply++) {
        const status = game.status();
        if (status.over) {
          if (status.result !== "1/2-1/2") result = (status.result === "1-0") === strongIsWhite ? 1 : 0;
          break;
        }
        const strongToMove = (game.turn === "w") === strongIsWhite;
        const r = chooseMove(START_FEN, game.uciMoves, strongToMove ? strong : weak, {
          random,
          timeMs: 1000,
          maxNodes: 6000,
        });
        expect(game.move(r.uci), r.uci).not.toBeNull();
        // Adjudicate by material: early for a crushing lead, else at the ply cap.
        let diff = 0;
        for (const p of game.board()) {
          if (p) diff += (p.color === "w") === strongIsWhite ? values[p.type] : -values[p.type];
        }
        if (diff >= 15 || (ply === 119 && diff >= 3)) result = 1;
        else if (diff <= -15 || (ply === 119 && diff <= -3)) result = 0;
        else continue;
        break;
      }
      points += result;
    }
    expect(points).toBeGreaterThanOrEqual(15);
  });

  it("reaches depth 5 from the start position within a second at level 10", () => {
    const t = Date.now();
    const r = chooseMove(START_FEN, [], bot("level-10"), { timeMs: 1000, random: seededRandom(3) });
    expect(Date.now() - t).toBeLessThan(1100);
    expect(r.depth).toBeGreaterThanOrEqual(5);
  });
});

describe("chooseMove", () => {
  it("lists 10 levels and the personalities", () => {
    expect(LEVEL_BOTS.map((b) => b.name)).toEqual(Array.from({ length: 10 }, (_, i) => `Level ${i + 1}`));
    expect(PERSONALITIES.length).toBeGreaterThanOrEqual(5);
    expect(new Set(ALL_BOTS.map((b) => b.id)).size).toBe(ALL_BOTS.length);
    const ratings = LEVEL_BOTS.map((b) => b.rating);
    expect([...ratings].sort((a, b) => a - b)).toEqual(ratings);
    expect(getBot("nope")).toBeUndefined();
  });

  it("every bot returns a legal move everywhere", () => {
    for (const b of ALL_BOTS) {
      LEGALITY.forEach((fen, i) => {
        const r = chooseMove(fen, [], b, { random: seededRandom(i + 1), timeMs: 25 });
        expect(legalUci(fen), `${b.id} on ${fen}`).toContain(r.uci);
      });
    }
  });

  it("returns an empty move when there is none", () => {
    const stalemate = "k7/2Q5/1K6/8/8/8/8/8 b - - 0 1";
    const mated = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    for (const fen of [stalemate, mated]) expect(chooseMove(fen, [], bot("level-5")).uci).toBe("");
  });

  it("replays history and stays legal there", () => {
    const history = ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1"];
    for (const id of ["level-1", "level-10", "aggro-annie"]) {
      const r = chooseMove(START_FEN, history, bot(id), { random: seededRandom(5), timeMs: 100 });
      expect(legalUci(START_FEN, history)).toContain(r.uci);
    }
    expect(() => chooseMove(START_FEN, ["e2e5"], bot("level-1"))).toThrow();
  });

  it("is reproducible with a seeded random", () => {
    const fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
    for (const id of ["level-1", "level-4", "level-8", "queenie", "random-randy"]) {
      const a = chooseMove(fen, [], bot(id), { random: seededRandom(42), timeMs: 5000 });
      const b = chooseMove(fen, [], bot(id), { random: seededRandom(42), timeMs: 5000 });
      expect(b, id).toEqual(a);
    }
  });

  it("personalities play to their style", () => {
    // Over a few opening moves, Pete pushes pawns and Queenie moves her queen
    // more often than the plain level of the same strength.
    const count = (b: BotConfig, pred: (game: Game, uci: string) => boolean): number => {
      let n = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const random = seededRandom(seed);
        const game = new Game();
        for (let ply = 0; ply < 16 && !game.status().over; ply++) {
          const r = chooseMove(START_FEN, game.uciMoves, game.turn === "w" ? b : bot("level-3"), { random });
          if (game.turn === "w" && pred(game, r.uci)) n++;
          game.move(r.uci);
        }
      }
      return n;
    };
    const pawn = (game: Game, uci: string) => game.get(uci.slice(0, 2))?.type === "p";
    const queen = (game: Game, uci: string) => game.get(uci.slice(0, 2))?.type === "q";
    expect(count(bot("pawnstorm-pete"), pawn)).toBeGreaterThan(count(bot("level-3"), pawn));
    expect(count(bot("queenie"), queen)).toBeGreaterThan(count(bot("level-5"), queen));
  });

  it("leaves the shared engine usable across many searches", () => {
    const eng = new Engine(12);
    const pos = Position.fromFen(START_FEN);
    for (let i = 0; i < 300; i++) eng.search(pos, new Evaluator(), { maxDepth: 1 });
    expect(pos.fen()).toBe(START_FEN);
  });
});
