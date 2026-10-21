import { describe, expect, it } from "vitest";
import { Game, Position, perft, toPgn } from "./index";

// Reference node counts from https://www.chessprogramming.org/Perft_Results
const PERFT: [string, string, number[]][] = [
  ["start", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", [20, 400, 8902, 197281, 4865609]],
  ["kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", [48, 2039, 97862, 4085603]],
  ["pos3", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", [14, 191, 2812, 43238, 674624]],
  ["pos4", "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", [6, 264, 9467, 422333]],
  ["pos5", "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", [44, 1486, 62379, 2103487]],
  ["pos6", "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", [46, 2079, 89890, 3894594]],
];

describe("perft", () => {
  for (const [name, fen, counts] of PERFT) {
    it(name, () => {
      const pos = Position.fromFen(fen);
      counts.forEach((n, i) => expect(perft(pos, i + 1)).toBe(n));
      expect(pos.fen()).toBe(fen);
    });
  }

  it("keeps the hash consistent through make/unmake", () => {
    const pos = Position.fromFen(PERFT[1][1]);
    const fresh = (p: Position) => Position.fromFen(p.fen());
    const walk = (depth: number): void => {
      for (const m of pos.generatePseudo()) {
        if (!pos.makeMove(m)) continue;
        const f = fresh(pos);
        expect([pos.hashLo, pos.hashHi]).toEqual([f.hashLo, f.hashHi]);
        if (depth > 1) walk(depth - 1);
        pos.unmakeMove();
      }
    };
    walk(3);
  });
});

describe("Game", () => {
  it("plays SAN and UCI and reports SAN with suffixes", () => {
    const g = new Game();
    for (const m of ["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6"]) expect(g.move(m)).not.toBeNull();
    const mate = g.move("h5f7");
    expect(mate?.san).toBe("Qxf7#");
    expect(g.status()).toEqual({ over: true, result: "1-0", reason: "checkmate" });
    expect(g.move("a7a6")).toBeNull();
  });

  it("disambiguates SAN", () => {
    const g = new Game("4k3/8/8/8/8/8/8/R4RK1 w - - 0 1");
    expect(g.move("a1d1")?.san).toBe("Rad1");
    const g2 = new Game("4k3/8/8/8/R7/8/8/R3K3 w - - 0 1");
    expect(g2.move("a1a2")?.san).toBe("R1a2");
    const g3 = new Game("4k3/8/8/8/8/8/Q1Q5/Q3K3 w - - 0 1");
    expect(g3.move("a2b1")?.san).toBe("Qa2b1");
  });

  it("handles castling, en passant and promotion", () => {
    const g = new Game("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    expect(g.move("e1g1")?.san).toBe("O-O");
    expect(g.move("O-O-O")?.castle).toBe("q");
    const ep = new Game("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
    const m = ep.move("e5d6");
    expect(m?.enPassant).toBe(true);
    expect(m?.captured).toBe("p");
    expect(ep.get("d5")).toBeNull();
    const promo = new Game("8/P6k/8/8/8/8/8/4K3 w - - 0 1");
    expect(promo.isPromotion("a7", "a8")).toBe(true);
    expect(promo.move({ from: "a7", to: "a8", promotion: "n" })?.san).toBe("a8=N");
    promo.undo();
    expect(promo.move("a7a8")?.promotion).toBe("q");
  });

  it("detects draws", () => {
    expect(new Game("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1").status().reason).toBe("stalemate");
    expect(new Game("8/8/4k3/8/8/2B5/4K3/8 w - - 0 1").status().reason).toBe("insufficient");
    expect(new Game("8/8/4k3/8/8/2N5/4K3/2N5 w - - 0 1").status().over).toBe(false);
    expect(new Game("4k3/8/8/8/8/8/R7/4K3 w - - 100 80").status().reason).toBe("fifty");
    const rep = new Game();
    for (const m of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1"]) rep.move(m);
    expect(rep.status().over).toBe(false);
    rep.move("Ng8");
    expect(rep.status().reason).toBe("repetition");
  });

  it("treats timeout against a lone minor piece as a draw", () => {
    const g = new Game("4k3/8/8/8/8/8/3N4/r3K3 b - - 0 1");
    expect(g.timeoutResult("b")).toEqual({ over: true, result: "1/2-1/2", reason: "timeout-insufficient" });
    expect(g.timeoutResult("w")).toEqual({ over: true, result: "0-1", reason: "timeout" });
  });

  it("undoes moves and rebuilds from UCI", () => {
    const g = Game.fromUci(["e2e4", "c7c5", "g1f3"]);
    expect(g.undo()?.san).toBe("Nf3");
    expect(g.fen()).toBe("rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2");
    expect(g.legalDests().get("g1")).toEqual(expect.arrayContaining(["f3", "h3", "e2"]));
  });

  it("writes PGN", () => {
    const g = Game.fromUci(["f2f3", "e7e5", "g2g4", "d8h4"]);
    const pgn = toPgn(g.moves, { white: "Alex", black: "Sam", result: "0-1", date: new Date(2026, 9, 21) });
    expect(pgn).toContain('[Date "2026.10.21"]');
    expect(pgn.trim().endsWith("1. f3 e5 2. g4 Qh4# 0-1")).toBe(true);
  });
});
