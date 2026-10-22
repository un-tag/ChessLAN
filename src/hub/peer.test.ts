import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL, type GameRecord } from "../shared/protocol";
import { computeRatings } from "../shared/ratings";
import { fetchHello, startHub, type Hub } from "./hub";

const dirs: string[] = [];
let a: Hub;
let b: Hub;

async function hub(extra: { heartbeatMs?: number; silentMs?: number } = {}): Promise<Hub> {
  const dir = mkdtempSync(join(tmpdir(), "chesslan-peer-"));
  dirs.push(dir);
  return startHub({ dataDir: dir, appVersion: "t", port: 0, host: "127.0.0.1", ...extra });
}

const record = (id: string, endedAt: number, result: GameRecord["result"] = "1-0"): GameRecord => ({
  id,
  white: { id: "alex", name: "Alex" },
  black: { id: "sam", name: "Sam" },
  tc: { initialMs: 60_000, incrementMs: 0 },
  category: "bullet",
  rated: true,
  moves: ["e2e4"],
  result,
  reason: "resign",
  startedAt: endedAt - 1000,
  endedAt,
});

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeEach(async () => {
  a = await hub();
  b = await hub();
});

afterEach(async () => {
  await a.close();
  await b.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("peer sync", () => {
  it("merges both logs, chat and players when linked, and ratings agree", async () => {
    a.store.addRecord(record("g1", 1000, "1-0"));
    a.store.addChat({ id: "c1", from: { id: "alex", name: "Alex" }, text: "hi", at: 1 });
    a.store.touchPlayer({ id: "alex", name: "Alex" });
    b.store.addRecord(record("g2", 2000, "0-1"));
    b.store.addRecord(record("g3", 2000, "1/2-1/2"));
    b.store.addChat({ id: "c2", from: { id: "sam", name: "Sam" }, text: "yo", at: 2 });
    b.store.touchPlayer({ id: "sam", name: "Sam" });

    b.linkTo(`127.0.0.1:${a.port}`);
    await until(() => a.store.records.length === 3 && b.store.records.length === 3);
    await until(() => a.store.chat.length === 2 && b.store.chat.length === 2);
    expect(b.linkedTo()).toBe(`127.0.0.1:${a.port}`);
    expect([...a.store.players.keys()].sort()).toEqual(["alex", "sam"]);
    expect([...b.store.players.keys()].sort()).toEqual(["alex", "sam"]);
    expect(a.store.chat.map((m) => m.id)).toEqual(["c1", "c2"]);
    // Same games, different file order: identical ratings everywhere.
    const ra = computeRatings(a.store.records).players.get("alex")?.bullet.rating;
    const rb = computeRatings(b.store.records).players.get("alex")?.bullet.rating;
    expect(ra).toBe(rb);
  });

  it("pushes new games and chat live, in both directions", async () => {
    b.linkTo(`127.0.0.1:${a.port}`);
    await until(() => b.linkedTo() !== null);
    // A client on hub A sends chat; it reaches B's copy.
    const ws = new WebSocket(`ws://127.0.0.1:${a.port}/ws`);
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, appVersion: "t", player: { id: "alex", name: "Alex" }, platform: "t" }));
    ws.send(JSON.stringify({ type: "chat", text: "live!" }));
    await until(() => b.store.chat.some((m) => m.text === "live!"));
    await until(() => b.store.players.has("alex"));
    // A bot game saved on B reaches A.
    const ws2 = new WebSocket(`ws://127.0.0.1:${b.port}/ws`);
    await new Promise((r) => ws2.once("open", r));
    ws2.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, appVersion: "t", player: { id: "sam", name: "Sam" }, platform: "t" }));
    const botGame = { ...record("bot-1", 3000), black: { id: "bot:level-1", name: "Level 1" }, white: { id: "sam", name: "Sam" }, bot: { id: "level-1", name: "Level 1", rating: 250, side: "b" as const } };
    ws2.send(JSON.stringify({ type: "saveRecord", record: botGame }));
    await until(() => a.store.records.some((r) => r.id === "bot-1"));
    ws.close();
    ws2.close();
  });

  it("refuses to link to itself and survives the peer going away", async () => {
    a.linkTo(`127.0.0.1:${a.port}`);
    await new Promise((r) => setTimeout(r, 200));
    expect(a.store.records).toHaveLength(0);
    b.linkTo(`127.0.0.1:${a.port}`);
    await until(() => b.linkedTo() !== null);
    await a.close();
    await until(() => b.linkedTo() === null);
    a = await hub(); // afterEach closes it
  });

  it("drops a peer link that goes silent", async () => {
    await a.close();
    a = await hub({ heartbeatMs: 40, silentMs: 150 });
    // A peer that never answers pings, like a computer gone to sleep.
    const asleep = new WebSocket(`ws://127.0.0.1:${a.port}/peer`, { autoPong: false });
    await new Promise((r) => asleep.once("open", r));
    await new Promise((r) => asleep.once("close", r));
    // A live link stays up.
    b.linkTo(`127.0.0.1:${a.port}`);
    await until(() => b.linkedTo() !== null);
    await new Promise((r) => setTimeout(r, 400));
    expect(b.linkedTo()).toBe(`127.0.0.1:${a.port}`);
  });

  it("describes itself and answers reachability questions", async () => {
    const info = await fetchHello(`127.0.0.1:${a.port}`);
    expect(info).toMatchObject({ app: "chesslan", protocol: PROTOCOL, nodeId: a.hubId, liveGame: false, winUpdates: false });
    const yes = await (await fetch(`http://127.0.0.1:${a.port}/reach?addr=127.0.0.1:${b.port}`)).json();
    expect(yes).toEqual({ ok: true, nodeId: b.hubId });
    const no = await (await fetch(`http://127.0.0.1:${a.port}/reach?addr=127.0.0.1:1`)).json();
    expect(no).toEqual({ ok: false, nodeId: null });
  });
});
