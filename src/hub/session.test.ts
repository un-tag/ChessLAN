import { beforeEach, describe, expect, it } from "vitest";
import type { GameView } from "../shared/protocol";
import { GameSession } from "./session";
import { FakeClock } from "./testing";

const W = { id: "w", name: "Alex" };
const B = { id: "b", name: "Sam" };

let clock: FakeClock;
let views: GameView[];
let finished: number;

function session(tc: { initialMs: number; incrementMs: number } | null = { initialMs: 60_000, incrementMs: 0 }) {
  return new GameSession({
    id: "g1",
    white: W,
    black: B,
    tc,
    rated: true,
    clock,
    flagGraceMs: () => 100,
    onChange: (v) => views.push(v),
    onFinish: () => finished++,
  });
}

const last = () => views[views.length - 1];

function play(s: GameSession, moves: string[], thinkMs = 0) {
  for (const m of moves) {
    const id = s.game.turn === "w" ? W.id : B.id;
    clock.advance(thinkMs);
    expect(s.move(id, m, s.ply, thinkMs)).toEqual({ ok: true });
  }
}

beforeEach(() => {
  clock = new FakeClock();
  views = [];
  finished = 0;
});

describe("GameSession clocks", () => {
  it("starts the clock only after both first moves", () => {
    const s = session();
    play(s, ["e2e4"], 5000);
    expect(last().clock).toMatchObject({ w: 60_000, b: 60_000, running: null });
    play(s, ["e7e5"], 5000);
    expect(last().clock).toMatchObject({ w: 60_000, b: 60_000, running: "w" });
    play(s, ["g1f3"], 3000);
    expect(last().clock).toMatchObject({ w: 57_000, b: 60_000, running: "b" });
  });

  it("charges client think time, not network lag", () => {
    const s = session();
    play(s, ["e2e4", "e7e5"]);
    clock.advance(2000); // hub saw 2 s, but the move spent 1.5 s in flight
    s.move(W.id, "g1f3", 2, 500);
    expect(last().clock?.w).toBe(59_500);
  });

  it("never charges more than the hub saw elapse", () => {
    const s = session();
    play(s, ["e2e4", "e7e5"]);
    clock.advance(1000);
    s.move(W.id, "g1f3", 2, 9999);
    expect(last().clock?.w).toBe(59_000);
  });

  it("adds increment after a timed move", () => {
    const s = session({ initialMs: 60_000, incrementMs: 2000 });
    play(s, ["e2e4", "e7e5"]);
    play(s, ["g1f3"], 1000);
    expect(last().clock?.w).toBe(61_000);
  });

  it("flags after time plus grace and records a timeout", () => {
    const s = session();
    play(s, ["e2e4", "e7e5"]);
    clock.advance(60_050);
    expect(s.over).toBe(false);
    clock.advance(100);
    expect(s.over).toBe(true);
    expect(last()).toMatchObject({ over: true, result: "0-1", reason: "timeout" });
    expect(finished).toBe(1);
  });

  it("rejects a move that arrives after the flag", () => {
    const s = session();
    play(s, ["e2e4", "e7e5"]);
    clock.advance(60_000);
    expect(s.move(W.id, "g1f3", 2, 60_000)).toEqual({ ok: false, error: "Time is up" });
    expect(s.result).toBe("0-1");
  });
});

describe("GameSession negotiation", () => {
  it("aborts before both moved, resign afterwards", () => {
    const s = session();
    play(s, ["e2e4"]);
    expect(s.resign(B.id)).toEqual({ ok: true });
    expect(s.reason).toBe("aborted");
    expect(finished).toBe(1);

    const s2 = session();
    play(s2, ["e2e4", "e7e5"]);
    expect(s2.abort(W.id).ok).toBe(false);
    s2.resign(W.id);
    expect(s2.result).toBe("0-1");
    expect(s2.reason).toBe("resign");
  });

  it("handles draw offers", () => {
    const s = session();
    play(s, ["e2e4", "e7e5"]);
    s.offerDraw(W.id);
    expect(last().drawOffer).toBe("w");
    s.respondDraw(B.id, false);
    expect(last().drawOffer).toBe(null);
    s.offerDraw(W.id);
    play(s, ["g1f3"]); // the offerer moving keeps the offer
    expect(last().drawOffer).toBe("w");
    play(s, ["b8c6"]); // the opponent moving declines it
    expect(last().drawOffer).toBe(null);
    s.offerDraw(B.id);
    s.offerDraw(W.id); // mutual offer = agreement
    expect(s.result).toBe("1/2-1/2");
    expect(s.reason).toBe("agreement");
  });

  it("takes back to the requester's turn", () => {
    const s = session();
    play(s, ["e2e4", "e7e5", "g1f3"]);
    // White just moved and asks to undo it.
    s.requestTakeback(W.id);
    s.respondTakeback(B.id, true);
    expect(s.game.uciMoves).toEqual(["e2e4", "e7e5"]);
    expect(s.game.turn).toBe("w");
    // Black asks after white's reply: undo two plies back to black's turn.
    play(s, ["g1f3", "b8c6", "f1c4"]);
    s.requestTakeback(B.id);
    s.respondTakeback(W.id, true);
    expect(s.game.uciMoves).toEqual(["e2e4", "e7e5", "g1f3"]);
    expect(s.game.turn).toBe("b");
    expect(last().clock?.running).toBe("b");
  });

  it("stops the clock when a takeback goes back before move two", () => {
    const s = session();
    play(s, ["e2e4", "e7e5"]);
    s.requestTakeback(B.id);
    s.respondTakeback(W.id, true);
    expect(s.game.uciMoves).toEqual(["e2e4"]);
    expect(last().clock?.running).toBe(null);
  });

  it("agrees a rematch only when both ask", () => {
    const s = session();
    play(s, ["f2f3", "e7e5", "g2g4", "d8h4"]);
    expect(s.result).toBe("0-1");
    expect(s.reason).toBe("checkmate");
    s.offerRematch(W.id);
    expect(s.rematchAgreed).toBe(false);
    s.offerRematch(B.id);
    expect(s.rematchAgreed).toBe(true);
  });
});

describe("GameSession disconnects", () => {
  it("awards the game after 60 s away", () => {
    const s = session({ initialMs: 600_000, incrementMs: 0 });
    play(s, ["e2e4", "e7e5"]);
    s.playerLeft(B.id);
    expect(last().disconnected?.side).toBe("b");
    clock.advance(59_000);
    expect(s.over).toBe(false);
    clock.advance(1000);
    expect(s).toMatchObject({ over: true, result: "1-0", reason: "abandon" });
  });

  it("resumes when the player comes back", () => {
    const s = session({ initialMs: 600_000, incrementMs: 0 });
    play(s, ["e2e4", "e7e5"]);
    s.playerLeft(W.id);
    clock.advance(30_000);
    s.playerReturned(W.id);
    expect(last().disconnected).toBe(null);
    clock.advance(60_000);
    expect(s.over).toBe(false);
    expect(last().clock?.w).toBe(600_000 - 30_000);
  });

  it("never re-arms timers after dispose", () => {
    const s = session({ initialMs: 600_000, incrementMs: 0 });
    play(s, ["e2e4", "e7e5"]);
    s.dispose();
    s.playerLeft(B.id);
    clock.advance(10 * 60_000);
    expect(s.over).toBe(false);
    expect(finished).toBe(0);
  });

  it("aborts instead when nobody has moved twice", () => {
    const s = session();
    play(s, ["e2e4"]);
    s.playerLeft(B.id);
    clock.advance(60_000);
    expect(s.reason).toBe("aborted");
  });
});
