import { describe, expect, it } from "vitest";
import { Game } from "../../shared/chess";
import {
  applyMove,
  applyPremoves,
  arrowShape,
  castlingAfterPremoves,
  cellToSquare,
  diffMoves,
  isSingleMove,
  moveHints,
  parseFen,
  placePieces,
  pointToSquare,
  premoveDests,
  promotionPlacement,
  sameBoard,
  sqIndex,
  sqName,
  squareToCell,
  type PieceCode,
  type Pieces,
} from "./premove";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Board with just the given pieces, e.g. board({ e1: "wK", h1: "wR" }). */
function board(placement: Record<string, PieceCode>): Pieces {
  const out: Pieces = new Array(64).fill(null);
  for (const [sq, code] of Object.entries(placement)) out[sqIndex(sq)] = code;
  return out;
}

const sorted = (a: string[]) => [...a].sort();

describe("squares and FEN", () => {
  it("maps square names to indices like Game.board()", () => {
    expect(sqIndex("a1")).toBe(0);
    expect(sqIndex("h1")).toBe(7);
    expect(sqIndex("e4")).toBe(28);
    expect(sqIndex("h8")).toBe(63);
    expect(sqIndex("i1")).toBe(-1);
    expect(sqIndex("a9")).toBe(-1);
    expect(sqIndex("")).toBe(-1);
    for (let i = 0; i < 64; i++) expect(sqIndex(sqName(i))).toBe(i);
  });

  it("parses placement, turn and castling consistently with Game", () => {
    const g = Game.fromUci(["e2e4", "c7c5", "g1f3"]);
    const p = parseFen(g.fen());
    expect(p.turn).toBe("b");
    expect(p.castling).toBe("KQkq");
    g.board().forEach((piece, i) => {
      expect(p.pieces[i]).toBe(piece ? `${piece.color}${piece.type.toUpperCase()}` : null);
    });
  });

  it("gives an empty board for garbage", () => {
    const p = parseFen("not a fen");
    expect(p.pieces.every((x) => x === null)).toBe(true);
    expect(p.turn).toBe("w");
  });
});

describe("applyMove", () => {
  it("moves a piece and captures", () => {
    const b = applyMove(parseFen(START).pieces, "e2", "e4");
    expect(b[sqIndex("e2")]).toBeNull();
    expect(b[sqIndex("e4")]).toBe("wP");
    const c = applyMove(board({ d4: "wQ", d7: "bP" }), "d4", "d7");
    expect(c[sqIndex("d7")]).toBe("wQ");
    expect(c.filter(Boolean)).toHaveLength(1);
  });

  it("castles both ways for both colours", () => {
    const b = board({ e1: "wK", h1: "wR", a1: "wR", e8: "bK", h8: "bR", a8: "bR" });
    const k = applyMove(b, "e1", "g1");
    expect([k[sqIndex("g1")], k[sqIndex("f1")], k[sqIndex("h1")], k[sqIndex("e1")]]).toEqual(["wK", "wR", null, null]);
    const q = applyMove(b, "e8", "c8");
    expect([q[sqIndex("c8")], q[sqIndex("d8")], q[sqIndex("a8")]]).toEqual(["bK", "bR", null]);
  });

  it("handles en passant unless disabled", () => {
    const b = board({ e5: "wP", d5: "bP" });
    const ep = applyMove(b, "e5", "d6");
    expect(ep[sqIndex("d5")]).toBeNull();
    expect(ep[sqIndex("d6")]).toBe("wP");
    const noEp = applyMove(b, "e5", "d6", { enPassant: false });
    expect(noEp[sqIndex("d5")]).toBe("bP");
  });

  it("promotes only when asked", () => {
    const b = board({ g7: "wP", b2: "bP" });
    expect(applyMove(b, "g7", "g8")[sqIndex("g8")]).toBe("wP");
    expect(applyMove(b, "g7", "g8", { promotion: "n" })[sqIndex("g8")]).toBe("wN");
    expect(applyMove(b, "b2", "a1", { promotion: "q" })[sqIndex("a1")]).toBe("bQ");
  });

  it("does not mutate its input", () => {
    const b = parseFen(START).pieces;
    const copy = b.slice();
    applyMove(b, "g1", "f3");
    expect(sameBoard(b, copy)).toBe(true);
  });

  it("matches the real rules engine for castling, en passant and promotion", () => {
    const lines = [
      ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "e1g1"],
      ["e2e4", "a7a6", "e4e5", "d7d5", "e5d6"],
      ["a2a4", "b7b5", "a4b5", "a7a6", "b5a6", "c8b7", "a6b7", "b8c6", "b7a8n"],
    ];
    for (const line of lines) {
      const g = new Game();
      for (const uci of line) {
        const before = parseFen(g.fen()).pieces;
        const info = g.move(uci);
        if (!info) throw new Error(`illegal ${uci}`);
        const after = parseFen(g.fen()).pieces;
        const mine = applyMove(before, info.from, info.to, { promotion: info.promotion });
        expect(sameBoard(mine, after)).toBe(true);
        expect(isSingleMove(before, after, info.from, info.to)).toBe(true);
      }
    }
  });
});

describe("premoveDests", () => {
  it("pawns: one forward, two from the start rank, diagonals regardless of occupancy", () => {
    const b = board({ e2: "wP", e3: "bN", d5: "bP", a7: "bP" });
    expect(sorted(premoveDests(b, "e2"))).toEqual(["d3", "e3", "e4", "f3"]);
    expect(sorted(premoveDests(b, "d5"))).toEqual(["c4", "d4", "e4"]);
    expect(sorted(premoveDests(b, "a7"))).toEqual(["a5", "a6", "b6"]);
    expect(premoveDests(board({ h8: "wP" }), "h8")).toEqual([]);
  });

  it("knights move normally", () => {
    expect(sorted(premoveDests(board({ g1: "wN" }), "g1"))).toEqual(["e2", "f3", "h3"]);
    expect(premoveDests(board({ d4: "bN" }), "d4")).toHaveLength(8);
  });

  it("sliders ignore blockers", () => {
    const b = board({ a1: "wR", a2: "wP", b1: "bN", c1: "wB", d1: "wQ", d2: "wP", e2: "wP", c2: "wP" });
    expect(premoveDests(b, "a1")).toHaveLength(14);
    expect(premoveDests(b, "a1")).toContain("a8");
    expect(premoveDests(b, "a1")).toContain("h1");
    expect(sorted(premoveDests(b, "c1"))).toEqual(["a3", "b2", "d2", "e3", "f4", "g5", "h6"]);
    expect(premoveDests(b, "d1")).toHaveLength(21);
    expect(premoveDests(b, "d1")).toContain("h5");
    expect(premoveDests(b, "d1")).toContain("a4");
  });

  it("includes squares of own pieces (recapture premoves)", () => {
    const b = board({ e4: "wP", d5: "wN" });
    expect(premoveDests(b, "e4")).toContain("d5");
  });

  it("king: one step, plus castling from the start square when the rook is home", () => {
    const b = board({ e1: "wK", h1: "wR", a1: "wR" });
    expect(sorted(premoveDests(b, "e1"))).toEqual(["c1", "d1", "d2", "e2", "f1", "f2", "g1"]);
    expect(premoveDests(b, "e1", "K")).not.toContain("c1");
    expect(premoveDests(b, "e1", "K")).toContain("g1");
    expect(premoveDests(b, "e1", "-")).not.toContain("g1");
    expect(premoveDests(board({ e1: "wK" }), "e1")).not.toContain("g1");
    expect(premoveDests(board({ e8: "bK", h8: "bR" }), "e8", "kq")).toContain("g8");
    expect(premoveDests(board({ e8: "bK", h8: "bR" }), "e8", "KQ")).not.toContain("g8");
    expect(sorted(premoveDests(board({ d4: "wK" }), "d4"))).toHaveLength(8);
  });

  it("is empty for an empty square", () => {
    expect(premoveDests(board({}), "e4")).toEqual([]);
  });
});

describe("applyPremoves", () => {
  it("applies a queue in order, on top of each other", () => {
    const start = parseFen(START).pieces;
    const b = applyPremoves(start, [
      { from: "e2", to: "e4" },
      { from: "e4", to: "e5" },
      { from: "g1", to: "f3" },
    ]);
    expect(b[sqIndex("e5")]).toBe("wP");
    expect(b[sqIndex("e2")]).toBeNull();
    expect(b[sqIndex("f3")]).toBe("wN");
    expect(start[sqIndex("e2")]).toBe("wP");
  });

  it("premove destinations are computed on the premoved board", () => {
    const start = parseFen(START).pieces;
    const after = applyPremoves(start, [{ from: "e2", to: "e4" }]);
    expect(sorted(premoveDests(after, "e4"))).toEqual(["d5", "e5", "f5"]);
    expect(premoveDests(after, "f1")).toContain("a6");
  });

  it("promotes to a queen by default and castles", () => {
    const b = applyPremoves(board({ b7: "wP", e1: "wK", h1: "wR" }), [
      { from: "b7", to: "b8" },
      { from: "e1", to: "g1" },
    ]);
    expect(b[sqIndex("b8")]).toBe("wQ");
    expect(b[sqIndex("f1")]).toBe("wR");
    expect(applyPremoves(board({ b7: "wP" }), [{ from: "b7", to: "a8", promotion: "n" }])[sqIndex("a8")]).toBe("wN");
  });

  it("skips premoves from empty squares and keeps captures drawn as captures", () => {
    const b = applyPremoves(board({ d4: "wB", g7: "bP" }), [
      { from: "a1", to: "a2" },
      { from: "d4", to: "g7" },
    ]);
    expect(b[sqIndex("g7")]).toBe("wB");
    expect(b.filter(Boolean)).toHaveLength(1);
  });

  it("drops castling rights spent by queued premoves", () => {
    expect(castlingAfterPremoves("KQkq", [{ from: "h1", to: "h3" }])).toBe("Qkq");
    expect(castlingAfterPremoves("KQkq", [{ from: "e1", to: "e2" }])).toBe("kq");
    expect(castlingAfterPremoves("KQ", [{ from: "a1", to: "b1" }])).toBe("K");
    expect(castlingAfterPremoves("-", [])).toBe("");
  });
});

describe("animation planning", () => {
  it("moveHints adds the rook for castling", () => {
    const b = board({ e1: "wK", h1: "wR", a1: "wR" });
    expect(moveHints(b, "e1", "g1")).toEqual([
      [sqIndex("e1"), sqIndex("g1")],
      [sqIndex("h1"), sqIndex("f1")],
    ]);
    expect(moveHints(b, "e1", "c1")).toEqual([
      [sqIndex("e1"), sqIndex("c1")],
      [sqIndex("a1"), sqIndex("d1")],
    ]);
    expect(moveHints(b, "a1", "a5")).toEqual([[sqIndex("a1"), sqIndex("a5")]]);
  });

  it("isSingleMove rejects other changes", () => {
    const start = parseFen(START).pieces;
    const two = applyMove(applyMove(start, "e2", "e4"), "e7", "e5");
    expect(isSingleMove(start, two, "e7", "e5")).toBe(false);
    expect(isSingleMove(start, start, "e2", "e4")).toBe(false);
  });

  it("diffMoves finds a single move, capture or castling, and nothing for big jumps", () => {
    const start = parseFen(START).pieces;
    expect(diffMoves(start, applyMove(start, "g1", "f3"))).toEqual([[sqIndex("g1"), sqIndex("f3")]]);
    const cap = board({ d4: "wQ", d7: "bP" });
    expect(diffMoves(cap, applyMove(cap, "d4", "d7"))).toEqual([[sqIndex("d4"), sqIndex("d7")]]);
    const castle = board({ e1: "wK", h1: "wR" });
    expect(sorted((diffMoves(castle, applyMove(castle, "e1", "g1")) ?? []).map(([a, b]) => sqName(a) + sqName(b)))).toEqual(
      ["e1g1", "h1f1"],
    );
    const promo = board({ a7: "wP" });
    expect(diffMoves(promo, applyMove(promo, "a7", "a8", { promotion: "q" }))).toEqual([[sqIndex("a7"), sqIndex("a8")]]);
    expect(diffMoves(board({}), start)).toBeNull();
    expect(diffMoves(board({ a1: "wR" }), board({ a2: "wN" }))).toBeNull();
  });

  it("placePieces keeps ids stable and animates hinted moves", () => {
    let n = 0;
    const id = () => ++n;
    const start = parseFen(START).pieces;
    const first = placePieces(null, start, [], id);
    expect(first).toHaveLength(32);
    expect(first.every((p) => p.motion === "none")).toBe(true);

    const after = applyMove(start, "e2", "e4");
    const hints = moveHints(start, "e2", "e4");
    const second = placePieces(first, after, hints, id);
    expect(second).toHaveLength(32);
    const pawn = second.find((p) => p.sq === sqIndex("e4"))!;
    expect(pawn.id).toBe(first.find((p) => p.sq === sqIndex("e2"))!.id);
    expect(pawn.motion).toBe("animate");
    expect(second.filter((p) => p.motion !== "none")).toHaveLength(1);
    // Sorted by id, so DOM order never changes.
    expect(second.map((p) => p.id)).toEqual([...second.map((p) => p.id)].sort((a, b) => a - b));
    expect(n).toBe(32);

    // Without a hint the same change is an instant jump of the same element.
    const third = placePieces(second, applyMove(after, "g1", "f3"), [], id);
    const knight = third.find((p) => p.sq === sqIndex("f3"))!;
    expect(knight.id).toBe(first.find((p) => p.sq === sqIndex("g1"))!.id);
    expect(knight.motion).toBe("instant");
    expect(n).toBe(32);
  });

  it("placePieces drops captured pieces and follows promotion", () => {
    let n = 100;
    const id = () => ++n;
    const b = board({ g7: "wP", h8: "bR", a1: "wK" });
    const first = placePieces(null, b, [], id);
    const pawnId = first.find((p) => p.code === "wP")!.id;
    const after = applyMove(b, "g7", "h8", { promotion: "q" });
    const next = placePieces(first, after, moveHints(b, "g7", "h8"), id);
    expect(next.map((p) => p.code).sort()).toEqual(["wK", "wQ"]);
    const queen = next.find((p) => p.code === "wQ")!;
    expect(queen.id).toBe(pawnId);
    expect(queen.motion).toBe("animate");
  });

  it("placePieces marks every piece instant when asked (orientation flip)", () => {
    let n = 0;
    const start = parseFen(START).pieces;
    const first = placePieces(null, start, [], () => ++n);
    const flipped = placePieces(first, start, [], () => ++n, true);
    expect(flipped.every((p) => p.motion === "instant")).toBe(true);
    expect(flipped.map((p) => p.id)).toEqual(first.map((p) => p.id));
  });
});

describe("geometry", () => {
  it("maps squares to cells for both orientations", () => {
    expect(squareToCell("a1", "w")).toEqual({ col: 0, row: 7 });
    expect(squareToCell("h8", "w")).toEqual({ col: 7, row: 0 });
    expect(squareToCell("a1", "b")).toEqual({ col: 7, row: 0 });
    expect(squareToCell("e2", "b")).toEqual({ col: 3, row: 1 });
    for (const o of ["w", "b"] as const) {
      for (let i = 0; i < 64; i++) {
        const { col, row } = squareToCell(i, o);
        expect(cellToSquare(col, row, o)).toBe(sqName(i));
      }
    }
    expect(cellToSquare(8, 0, "w")).toBeNull();
  });

  it("hit-tests points, null off the board", () => {
    expect(pointToSquare(5, 795, 800, 800, "w")).toBe("a1");
    expect(pointToSquare(450, 650, 800, 800, "w")).toBe("e2");
    expect(pointToSquare(450, 650, 800, 800, "b")).toBe("d7");
    expect(pointToSquare(799.9, 0, 800, 800, "w")).toBe("h8");
    expect(pointToSquare(800, 10, 800, 800, "w")).toBeNull();
    expect(pointToSquare(-1, 10, 800, 800, "w")).toBeNull();
    expect(pointToSquare(10, 10, 0, 0, "w")).toBeNull();
  });

  it("draws straight arrows ending at the target centre and L-shaped knight arrows", () => {
    const straight = arrowShape("e2", "e4", "w");
    expect(straight.head.split(" ")[0]).toBe("4.5,4.5");
    expect(straight.shaft.split(" ")).toHaveLength(2);
    const knight = arrowShape("g1", "f3", "w");
    const pts = knight.shaft.split(" ");
    expect(pts).toHaveLength(3);
    expect(pts[1]).toBe("6.5,5.5"); // long leg first: up two squares, then left
    expect(knight.head.split(" ")[0]).toBe("5.5,5.5");
    expect(arrowShape("e2", "e4", "b").head.split(" ")[0]).toBe("3.5,3.5");
  });

  it("puts the promotion picker on the promotion file, growing towards the centre", () => {
    expect(promotionPlacement("e8", "w")).toEqual({ col: 4, fromTop: true });
    expect(promotionPlacement("e1", "w")).toEqual({ col: 4, fromTop: false });
    expect(promotionPlacement("e1", "b")).toEqual({ col: 3, fromTop: true });
    expect(promotionPlacement("a8", "b")).toEqual({ col: 7, fromTop: false });
  });
});
