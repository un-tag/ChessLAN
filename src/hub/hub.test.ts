import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL, type ClientMessage, type GameView, type ServerMessage } from "../shared/protocol";
import { startHub, type Hub } from "./hub";

let hub: Hub;
let dir: string;

class TestClient {
  ws: WebSocket;
  inbox: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  /** `autoPong: false` plays a computer that has gone to sleep. */
  constructor(public id: string, public name: string, opts: { autoPong?: boolean } = {}) {
    this.ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`, opts);
    this.ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      this.inbox.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
  }

  async open(): Promise<this> {
    await new Promise((r) => this.ws.once("open", r));
    this.send({ type: "hello", protocol: PROTOCOL, appVersion: "test", player: { id: this.id, name: this.name }, platform: "test" });
    await this.next("welcome");
    return this;
  }

  send(m: ClientMessage): void {
    this.ws.send(JSON.stringify(m));
  }

  next<T extends ServerMessage["type"]>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true) {
    const found = this.inbox.find((m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>));
    if (found) {
      this.inbox.splice(this.inbox.indexOf(found), 1);
      return Promise.resolve(found as Extract<ServerMessage, { type: T }>);
    }
    return new Promise<Extract<ServerMessage, { type: T }>>((resolve) => {
      this.waiters.push({
        pred: (m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>),
        resolve: (m) => {
          this.inbox.splice(this.inbox.indexOf(m), 1);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }

  game(pred: (g: GameView) => boolean): Promise<GameView> {
    return this.next("game", (m) => pred(m.game)).then((m) => m.game);
  }

  close(): void {
    this.ws.close();
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "chesslan-hub-"));
  hub = await startHub({ dataDir: dir, appVersion: "test", port: 0, host: "127.0.0.1" });
});

afterEach(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

async function startGame(a: TestClient, b: TestClient, color: "white" | "black" = "white") {
  a.send({ type: "challenge", to: b.id, spec: { tc: { initialMs: 60_000, incrementMs: 0 }, color, rated: true } });
  const { challenges } = await b.next("challenges", (m) => m.challenges.length > 0);
  b.send({ type: "challengeRespond", id: challenges[0].id, accept: true });
  return a.game((g) => g.moves.length === 0);
}

describe("hub", () => {
  it("answers /hello for discovery", async () => {
    const res = await fetch(`http://127.0.0.1:${hub.port}/hello`);
    expect(await res.json()).toMatchObject({ app: "chesslan", protocol: PROTOCOL, hubId: hub.hubId });
  });

  it("fails cleanly when the port is taken", async () => {
    await expect(startHub({ dataDir: dir, appVersion: "test", port: hub.port, host: "127.0.0.1" })).rejects.toThrow(/EADDRINUSE/);
  });

  it("rejects a different protocol version", async () => {
    const c = new TestClient("x", "X");
    await new Promise((r) => c.ws.once("open", r));
    c.send({ type: "hello", protocol: 999, appVersion: "9", player: { id: "x", name: "X" }, platform: "t" });
    expect(await c.next("versionMismatch")).toMatchObject({ hubProtocol: PROTOCOL });
    c.close();
  });

  it("plays a full game, records it and rates it", async () => {
    const alex = await new TestClient("alex", "Alex").open();
    const sam = await new TestClient("sam", "Sam").open();
    const g = await startGame(alex, sam, "white");
    expect(g.white.id).toBe("alex");
    const moves = ["f2f3", "e7e5", "g2g4", "d8h4"];
    for (const [i, uci] of moves.entries()) {
      const mover = i % 2 === 0 ? alex : sam;
      mover.send({ type: "move", gameId: g.id, uci, ply: i, thinkMs: 10 });
      await alex.game((v) => v.moves.length === i + 1);
    }
    const end = await sam.game((v) => v.over);
    expect(end).toMatchObject({ result: "0-1", reason: "checkmate" });
    expect(end.ratingChange).toMatchObject({ category: "bullet", w: { before: 400, after: 384 }, b: { before: 400, after: 416 } });
    const { record } = await alex.next("record");
    expect(record.moves).toEqual(moves);
    expect(hub.store.records).toHaveLength(1);

    alex.send({ type: "rematch", gameId: g.id });
    sam.send({ type: "rematch", gameId: g.id });
    const next = await alex.game((v) => v.id !== g.id);
    expect(next.white.id).toBe("sam");
    alex.close();
    sam.close();
  });

  it("rejects illegal and out-of-turn moves", async () => {
    const alex = await new TestClient("alex", "Alex").open();
    const sam = await new TestClient("sam", "Sam").open();
    const g = await startGame(alex, sam, "white");
    sam.send({ type: "move", gameId: g.id, uci: "e7e5", ply: 0 });
    expect(await sam.next("error")).toMatchObject({ message: "Not your turn" });
    alex.send({ type: "move", gameId: g.id, uci: "e2e5", ply: 0 });
    expect(await alex.next("error")).toMatchObject({ message: "Illegal move" });
    alex.close();
    sam.close();
  });

  it("declines and cancels challenges", async () => {
    const alex = await new TestClient("alex", "Alex").open();
    const sam = await new TestClient("sam", "Sam").open();
    alex.send({ type: "challenge", to: "sam", spec: { tc: null, color: "random", rated: true } });
    const { challenges } = await sam.next("challenges", (m) => m.challenges.length > 0);
    expect(challenges[0].rated).toBe(false); // untimed games are never rated
    sam.send({ type: "challengeRespond", id: challenges[0].id, accept: false });
    expect(await alex.next("challengeDeclined")).toMatchObject({ by: { id: "sam" } });
    alex.close();
    sam.close();
  });

  it("holds a challenge for a player whose app isn't running yet", async () => {
    const sam = await new TestClient("sam", "Sam").open();
    sam.close(); // Sam is known to the hub but offline.
    const alex = await new TestClient("alex", "Alex").open();
    alex.send({ type: "challenge", to: "sam", spec: { tc: { initialMs: 60_000, incrementMs: 0 }, color: "random", rated: true } });
    await alex.next("challenges", (m) => m.challenges.length === 1);
    const sam2 = await new TestClient("sam", "Sam").open();
    const { challenges } = await sam2.next("challenges", (m) => m.challenges.length === 1);
    expect(challenges[0].from.id).toBe("alex");
    alex.close();
    sam2.close();
  });

  it("tells the challenger once the popup is on screen, and forgets it if they drop off", async () => {
    const alex = await new TestClient("alex", "Alex").open();
    const sam = await new TestClient("sam", "Sam").open();
    alex.send({ type: "challenge", to: "sam", spec: { tc: { initialMs: 60_000, incrementMs: 0 }, color: "random", rated: true } });
    const { challenges } = await sam.next("challenges", (m) => m.challenges.length === 1);
    const id = challenges[0].id;
    expect(challenges[0].shownAt).toBeUndefined();
    // Only the challenged player can confirm it.
    alex.send({ type: "challengeShown", id });
    alex.send({ type: "ping", t: 1 });
    await alex.next("pong");
    expect(alex.inbox.some((m) => m.type === "challenges" && m.challenges[0]?.shownAt)).toBe(false);
    sam.send({ type: "challengeShown", id });
    await alex.next("challenges", (m) => !!m.challenges[0]?.shownAt);
    // Sam's app drops off: the popup went with it.
    sam.close();
    await alex.next("challenges", (m) => m.challenges.length === 1 && !m.challenges[0].shownAt);
    const sam2 = await new TestClient("sam", "Sam").open();
    const again = await sam2.next("challenges", (m) => m.challenges.length === 1);
    expect(again.challenges[0]).toMatchObject({ id });
    expect(again.challenges[0].shownAt).toBeUndefined();
    alex.close();
    sam2.close();
  });

  it("shares each player's microphone state and ignores junk", async () => {
    const alex = await new TestClient("alex", "Alex").open();
    const sam = await new TestClient("sam", "Sam").open();
    const samMic = (m: { players: { id: string; mic: unknown }[] }) => m.players.find((p) => p.id === "sam")?.mic;
    sam.send({ type: "presence", windowOpen: true, activity: "idle", mic: "muted" });
    await alex.next("players", (m) => samMic(m) === "muted");
    sam.send({ type: "presence", windowOpen: true, activity: "idle", mic: "loud" as never });
    await alex.next("players", (m) => samMic(m) === null);
    alex.close();
    sam.close();
  });

  it("drops a player whose computer goes silent, and keeps one that answers", async () => {
    await hub.close();
    hub = await startHub({ dataDir: dir, appVersion: "test", port: 0, host: "127.0.0.1", heartbeatMs: 40, silentMs: 150 });
    const alex = await new TestClient("alex", "Alex").open();
    const sam = await new TestClient("sam", "Sam", { autoPong: false }).open();
    await alex.next("players", (m) => m.players.some((p) => p.id === "sam" && p.online));
    // Sam never answers a ping, as if asleep. Alex's socket answers by itself.
    await alex.next("players", (m) => m.players.some((p) => p.id === "sam" && !p.online));
    await new Promise((r) => setTimeout(r, 400));
    expect(alex.ws.readyState).toBe(WebSocket.OPEN);
    alex.close();
    sam.close();
  });

  it("starts the game when both challenge each other the same way", async () => {
    const alex = await new TestClient("alex", "Alex").open();
    const sam = await new TestClient("sam", "Sam").open();
    const spec = { tc: { initialMs: 600_000, incrementMs: 0 }, color: "random" as const, rated: true };
    alex.send({ type: "challenge", to: "sam", spec });
    await sam.next("challenges", (m) => m.challenges.length === 1);
    sam.send({ type: "challenge", to: "alex", spec });
    const g = await alex.game((v) => v.moves.length === 0);
    expect([g.white.id, g.black.id].sort()).toEqual(["alex", "sam"]);
    alex.close();
    sam.close();
  });

  it("only treats live games as busy, whatever the app reports", async () => {
    const alex = await new TestClient("alex", "Alex").open();
    const sam = await new TestClient("sam", "Sam").open();
    sam.send({ type: "presence", windowOpen: true, activity: "game", mic: null });
    const { players } = await alex.next("players", (m) => m.players.some((p) => p.id === "sam" && p.windowOpen));
    expect(players.find((p) => p.id === "sam")?.activity).toBe("idle");
    alex.close();
    sam.close();
  });

  it("relays chat and WebRTC signalling, and keeps chat history", async () => {
    const alex = await new TestClient("alex", "Alex").open();
    const sam = await new TestClient("sam", "Sam").open();
    alex.send({ type: "chat", text: "  good luck!  " });
    expect((await sam.next("chat")).message).toMatchObject({ text: "good luck!", from: { id: "alex" } });
    alex.send({ type: "rtc", to: "sam", data: { sdp: "x" } });
    expect(await sam.next("rtc")).toEqual({ type: "rtc", from: "alex", data: { sdp: "x" } });
    sam.close();
    const sam2 = await new TestClient("sam", "Sam").open();
    const { messages } = await sam2.next("chatHistory");
    expect(messages.map((m) => m.text)).toEqual(["good luck!"]);
    alex.close();
    sam2.close();
  });

  it("resumes a game after reconnecting", async () => {
    const alex = await new TestClient("alex", "Alex").open();
    const sam = await new TestClient("sam", "Sam").open();
    const g = await startGame(alex, sam, "white");
    alex.send({ type: "move", gameId: g.id, uci: "e2e4", ply: 0 });
    await sam.game((v) => v.moves.length === 1);
    sam.close();
    const gone = await alex.game((v) => v.disconnected !== null);
    expect(gone.disconnected?.side).toBe("b");
    const sam2 = await new TestClient("sam", "Sam").open();
    const resumed = await sam2.game((v) => v.id === g.id);
    expect(resumed.moves).toEqual(["e2e4"]);
    await alex.game((v) => v.disconnected === null);
    alex.close();
    sam2.close();
  });

  it("stores bot games as unrated history", async () => {
    const alex = await new TestClient("alex", "Alex").open();
    alex.send({
      type: "saveRecord",
      record: {
        id: "bot-1",
        white: { id: "alex", name: "Alex" },
        black: { id: "bot:level-3", name: "Level 3" },
        tc: null,
        category: "untimed",
        rated: true,
        moves: ["e2e4"],
        result: "1-0",
        reason: "resign",
        startedAt: 1,
        endedAt: 2,
        bot: { id: "level-3", name: "Level 3", rating: 550, side: "b" },
      },
    });
    expect((await alex.next("record")).record).toMatchObject({ id: "bot-1", rated: false });
    alex.close();
  });
});
