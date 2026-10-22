// Every ChessLAN app runs a hub. It keeps that computer's full copy of the
// game log, chat and known players, and syncs them with the other peer's hub
// over /peer. The hub elected referee also runs live games: it relays
// challenges, runs game sessions and relays WebRTC signalling for voice.
// The Mac's hub additionally serves the Windows update files.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { Side } from "../shared/chess/game";
import {
  CHALLENGE_TTL_MS,
  HEARTBEAT_MS,
  HUB_PORT,
  MIC_STATES,
  PROTOCOL,
  SILENT_MS,
  type Activity,
  type Challenge,
  type ChatMessage,
  type ClientMessage,
  type GameRecord,
  type HelloInfo,
  type KnownPlayer,
  type MicState,
  type PeerMessage,
  type PlayerPresence,
  type PlayerRef,
  type ServerMessage,
} from "../shared/protocol";
import { computeRatings } from "../shared/ratings";
import { categoryOf, type TimeControl } from "../shared/timeControl";
import { GameSession, realClock, type ActionResult, type Clock } from "./session";
import { Store } from "./store";

export interface HubOptions {
  dataDir: string;
  appVersion: string;
  port?: number; // 0 = pick a free port
  host?: string;
  hostName?: string;
  /** Serve the renderer build so the UI also works in a plain browser (tests, dev). */
  staticDir?: string;
  /** Directory holding the Windows update feed (latest.yml + installer). */
  updatesDir?: string;
  clock?: Clock;
  log?: (msg: string) => void;
  /** Liveness timing (real time, not `clock`); tests shorten it. */
  heartbeatMs?: number;
  silentMs?: number;
}

export interface Hub {
  port: number;
  /** This peer's stable id (also used for the referee election). */
  hubId: string;
  store: Store;
  /** Keep an outbound sync link to another peer's hub ("host:port"). */
  linkTo(host: string): void;
  unlink(): void;
  /** The host we're linked to over an open outbound link, if any. */
  linkedTo(): string | null;
  hasLiveGame(): boolean;
  close(): Promise<void>;
}

interface PeerLink {
  ws: WebSocket;
  nodeId: string | null;
}

const PEER_BATCH = 200;
const PEER_MAX_PAYLOAD = 32 * 1024 * 1024;

/** GET http://host/hello, or null if it isn't a ChessLAN hub. */
export function fetchHello(host: string, timeoutMs = 1500): Promise<HelloInfo | null> {
  return new Promise((resolve) => {
    const m = /^(.+?)(?::(\d+))?$/.exec(host);
    if (!m) return resolve(null);
    const req = request({ host: m[1], port: Number(m[2] ?? HUB_PORT), path: "/hello", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const info = JSON.parse(body) as HelloInfo;
          resolve(info.app === "chesslan" ? info : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

interface Conn {
  ws: WebSocket;
  player?: PlayerRef;
  windowOpen: boolean;
  activity: Activity;
  mic: MicState | null;
  rtt: number;
  local: boolean;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".yml": "text/yaml",
  ".exe": "application/octet-stream",
  ".blockmap": "application/octet-stream",
  ".woff2": "font/woff2",
};

const MAX_CHAT = 1000;

export async function startHub(opts: HubOptions): Promise<Hub> {
  const clock = opts.clock ?? realClock;
  const log = opts.log ?? (() => {});
  const store = new Store(opts.dataDir);
  const conns = new Map<string, Conn>(); // by player id
  const sessions = new Map<string, GameSession>();
  const challenges = new Map<string, Challenge>();
  const challengeTimers = new Map<string, unknown>();

  const winUpdateAvailable = (): boolean =>
    !!opts.updatesDir && existsSync(join(opts.updatesDir, "latest.yml"));

  const send = (conn: Conn | undefined, msg: ServerMessage): void => {
    if (conn && conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  };
  const sendTo = (playerId: string, msg: ServerMessage): void => send(conns.get(playerId), msg);
  const broadcast = (msg: ServerMessage): void => {
    for (const c of conns.values()) send(c, msg);
  };

  const activeSessionOf = (playerId: string): GameSession | undefined =>
    [...sessions.values()].find((s) => !s.over && s.sideOf(playerId));

  const presence = (): PlayerPresence[] =>
    [...store.players.values()].map((p) => {
      const c = conns.get(p.id);
      return {
        id: p.id,
        name: p.name,
        online: !!c,
        windowOpen: c?.windowOpen ?? false,
        activity: activeSessionOf(p.id) ? "game" : (c?.activity ?? "idle"),
        mic: c?.mic ?? null,
      };
    });
  const broadcastPlayers = (): void => broadcast({ type: "players", players: presence() });

  const sendChallenges = (): void => {
    for (const [id, c] of conns) {
      const mine = [...challenges.values()].filter((ch) => ch.from.id === id || ch.to.id === id);
      send(c, { type: "challenges", challenges: mine });
    }
  };

  const removeChallenge = (id: string): void => {
    challenges.delete(id);
    const t = challengeTimers.get(id);
    if (t !== undefined) clock.clearTimeout(t);
    challengeTimers.delete(id);
  };

  // ---- Games ----

  const pushGame = (s: GameSession): void => {
    const view = s.view();
    sendTo(s.white.id, { type: "game", game: view });
    sendTo(s.black.id, { type: "game", game: view });
  };

  const onFinish = (s: GameSession): void => {
    broadcastPlayers();
    if (!s.result || s.reason === "aborted" || !s.reason) return;
    const record: GameRecord = {
      id: s.id,
      white: s.white,
      black: s.black,
      tc: s.tc,
      category: categoryOf(s.tc),
      rated: s.rated,
      moves: s.game.uciMoves,
      result: s.result,
      reason: s.reason,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? clock.now(),
    };
    if (store.addRecord(record)) {
      const change = computeRatings(store.records).changes.get(record.id);
      if (change) s.ratingChange = change;
      broadcast({ type: "record", record });
      toPeers(null, { type: "records", records: [record] });
    }
  };

  const createSession = (white: PlayerRef, black: PlayerRef, tc: TimeControl | null, rated: boolean): GameSession => {
    const s = new GameSession({
      id: randomUUID(),
      white,
      black,
      tc,
      rated,
      clock,
      flagGraceMs: (side: Side) => {
        const c = conns.get(side === "w" ? white.id : black.id);
        return Math.min(1000, 150 + (c?.rtt ?? 0));
      },
      onChange: () => pushGame(s),
      onFinish,
    });
    sessions.set(s.id, s);
    // Drop old finished sessions; only the latest per player matters (rematch).
    for (const [id, old] of sessions) {
      if (old.over && old !== s && sessions.size > 10) {
        old.dispose();
        sessions.delete(id);
      }
    }
    for (const ch of [...challenges.values()]) {
      if ([ch.from.id, ch.to.id].some((id) => id === white.id || id === black.id)) removeChallenge(ch.id);
    }
    sendChallenges();
    pushGame(s);
    broadcastPlayers();
    log(`game ${s.id} started: ${white.name} vs ${black.name}`);
    return s;
  };

  const startChallenge = (ch: Challenge): void => {
    const challengerWhite = ch.color === "white" ? true : ch.color === "black" ? false : Math.random() < 0.5;
    const [white, black] = challengerWhite ? [ch.from, ch.to] : [ch.to, ch.from];
    createSession(white, black, ch.tc, ch.rated);
  };

  const withSession = (conn: Conn, gameId: string, fn: (s: GameSession, playerId: string) => ActionResult): void => {
    const s = sessions.get(gameId);
    if (!s || !conn.player) return send(conn, { type: "error", message: "Unknown game" });
    const res = fn(s, conn.player.id);
    if (!res.ok) {
      send(conn, { type: "error", message: res.error });
      pushGame(s); // resync the client
    }
  };

  // ---- Messages ----

  const handle = (conn: Conn, msg: ClientMessage): void => {
    if (msg.type === "hello") return hello(conn, msg);
    if (!conn.player) return send(conn, { type: "error", message: "Say hello first" });
    const me = conn.player;
    switch (msg.type) {
      case "presence":
        conn.windowOpen = !!msg.windowOpen;
        // Only live hub games count as "in a game"; a result screen doesn't.
        conn.activity = msg.activity === "bot" ? "bot" : "idle";
        conn.mic = MIC_STATES.includes(msg.mic as MicState) ? (msg.mic as MicState) : null;
        return broadcastPlayers();
      case "ping":
        if (typeof msg.rtt === "number" && msg.rtt >= 0) conn.rtt = conn.rtt ? conn.rtt * 0.7 + msg.rtt * 0.3 : msg.rtt;
        return send(conn, { type: "pong", t: msg.t, serverTime: clock.now() });
      case "challenge": {
        // Known players can be challenged even if their app isn't running:
        // the challenge pops up when it connects (until it expires).
        const target = store.players.get(msg.to);
        if (!target || msg.to === me.id) return send(conn, { type: "error", message: "Unknown player" });
        if (activeSessionOf(me.id)) return send(conn, { type: "error", message: "Finish your current game first" });
        if (activeSessionOf(msg.to)) return send(conn, { type: "error", message: `${target.name} is in a game` });
        const tcKey = (tc: TimeControl | null) => (tc ? `${tc.initialMs}+${tc.incrementMs}` : "none");
        const rated = msg.spec.rated && !!msg.spec.tc;
        // Both challenged each other with the same settings: just start.
        const crossing = [...challenges.values()].find(
          (c) => c.from.id === msg.to && c.to.id === me.id && tcKey(c.tc) === tcKey(msg.spec.tc) && c.rated === rated,
        );
        if (crossing) {
          removeChallenge(crossing.id);
          return startChallenge(crossing);
        }
        for (const ch of [...challenges.values()]) if (ch.from.id === me.id) removeChallenge(ch.id);
        const ch: Challenge = {
          id: randomUUID(),
          from: me,
          to: { id: target.id, name: target.name },
          tc: msg.spec.tc,
          color: msg.spec.color,
          rated,
          createdAt: clock.now(),
        };
        challenges.set(ch.id, ch);
        challengeTimers.set(
          ch.id,
          clock.setTimeout(() => {
            removeChallenge(ch.id);
            sendChallenges();
          }, CHALLENGE_TTL_MS),
        );
        return sendChallenges();
      }
      case "challengeCancel": {
        const ch = challenges.get(msg.id);
        if (ch && ch.from.id === me.id) removeChallenge(ch.id);
        return sendChallenges();
      }
      case "challengeShown": {
        const ch = challenges.get(msg.id);
        if (!ch || ch.to.id !== me.id || ch.shownAt) return;
        ch.shownAt = clock.now();
        return sendChallenges();
      }
      case "challengeRespond": {
        const ch = challenges.get(msg.id);
        if (!ch || ch.to.id !== me.id) {
          sendChallenges();
          return send(conn, { type: "error", message: "That challenge is gone" });
        }
        removeChallenge(ch.id);
        if (!msg.accept) {
          sendTo(ch.from.id, { type: "challengeDeclined", id: ch.id, by: me });
          return sendChallenges();
        }
        if (!conns.has(ch.from.id)) {
          sendChallenges();
          return send(conn, { type: "error", message: `${ch.from.name} went offline` });
        }
        return startChallenge(ch);
      }
      case "move":
        return withSession(conn, msg.gameId, (s, id) => s.move(id, msg.uci, msg.ply, msg.thinkMs));
      case "resign":
        return withSession(conn, msg.gameId, (s, id) => s.resign(id));
      case "abort":
        return withSession(conn, msg.gameId, (s, id) => s.abort(id));
      case "drawOffer":
        return withSession(conn, msg.gameId, (s, id) => s.offerDraw(id));
      case "drawRespond":
        return withSession(conn, msg.gameId, (s, id) => s.respondDraw(id, msg.accept));
      case "takebackRequest":
        return withSession(conn, msg.gameId, (s, id) => s.requestTakeback(id));
      case "takebackRespond":
        return withSession(conn, msg.gameId, (s, id) => s.respondTakeback(id, msg.accept));
      case "rematch":
        return withSession(conn, msg.gameId, (s, id) => {
          const res = s.offerRematch(id);
          if (res.ok && s.rematchAgreed) {
            if (activeSessionOf(s.white.id) || activeSessionOf(s.black.id)) {
              return { ok: false, error: "Someone is already in another game" };
            }
            const next = createSession(s.black, s.white, s.tc, s.rated);
            s.setNextGame(next.id);
          }
          return res;
        });
      case "chat": {
        const text = String(msg.text ?? "").trim().slice(0, MAX_CHAT);
        if (!text) return;
        const message = { id: randomUUID(), from: me, text, at: clock.now() };
        store.addChat(message);
        toPeers(null, { type: "chat", messages: [message] });
        return broadcast({ type: "chat", message });
      }
      case "rtc":
        return sendTo(msg.to, { type: "rtc", from: me.id, data: msg.data });
      case "saveRecord": {
        const r = msg.record;
        const valid =
          r &&
          typeof r.id === "string" &&
          r.bot &&
          (r.white.id === me.id || r.black.id === me.id) &&
          Array.isArray(r.moves);
        if (!valid) return send(conn, { type: "error", message: "Bad record" });
        const record = { ...r, rated: false };
        if (store.addRecord(record)) {
          broadcast({ type: "record", record });
          toPeers(null, { type: "records", records: [record] });
        }
        return;
      }
      default:
        return send(conn, { type: "error", message: "Unknown message" });
    }
  };

  const hello = (conn: Conn, msg: Extract<ClientMessage, { type: "hello" }>): void => {
    if (msg.protocol !== PROTOCOL) {
      send(conn, {
        type: "versionMismatch",
        hubProtocol: PROTOCOL,
        hubVersion: opts.appVersion,
        winUpdateAvailable: winUpdateAvailable(),
      });
      return;
    }
    const id = String(msg.player?.id ?? "");
    const name = String(msg.player?.name ?? "").trim().slice(0, 30) || "Player";
    if (!id) return send(conn, { type: "error", message: "Missing player id" });
    const previous = conns.get(id);
    if (previous && previous !== conn) previous.ws.close(4000, "replaced");
    conn.player = { id, name };
    conns.set(id, conn);
    store.touchPlayer(conn.player);
    toPeers(null, { type: "players", players: [...store.players.values()] });
    send(conn, {
      type: "welcome",
      you: id,
      hubId: store.meta.hubId,
      hostName: opts.hostName ?? "Host",
      serverTime: clock.now(),
      appVersion: opts.appVersion,
      update: { hubVersion: opts.appVersion, winUpdateAvailable: winUpdateAvailable() },
    });
    send(conn, { type: "history", records: store.records });
    send(conn, { type: "chatHistory", messages: store.chat });
    broadcastPlayers();
    sendChallenges();
    // Resume a live game, or show the most recent finished one (for rematch).
    const live = activeSessionOf(id);
    if (live) {
      live.playerReturned(id);
      send(conn, { type: "game", game: live.view() });
    }
    log(`${name} connected${conn.local ? " (local)" : ""}`);
  };

  let closing = false;

  const onClose = (conn: Conn): void => {
    const p = conn.player;
    if (closing || !p || conns.get(p.id) !== conn) return;
    conns.delete(p.id);
    for (const ch of [...challenges.values()]) {
      if (ch.from.id === p.id) removeChallenge(ch.id);
      // Their popup is gone with the app; it has to show again.
      else if (ch.to.id === p.id) delete ch.shownAt;
    }
    activeSessionOf(p.id)?.playerLeft(p.id);
    sendChallenges();
    broadcastPlayers();
    log(`${p.name} disconnected`);
  };

  // ---- Peer sync ----
  // Both ends of a link send their ids; each replies with what the other is
  // missing, then new records, chat and players are pushed as they happen.

  const peerLinks = new Set<PeerLink>();
  let outbound: { host: string; ws: WebSocket } | null = null;

  const sendPeer = (link: PeerLink, msg: PeerMessage): void => {
    if (link.ws.readyState === WebSocket.OPEN) link.ws.send(JSON.stringify(msg));
  };
  function toPeers(except: PeerLink | null, msg: PeerMessage): void {
    for (const link of peerLinks) if (link !== except) sendPeer(link, msg);
  }

  const isRecord = (r: GameRecord): boolean =>
    !!r && typeof r.id === "string" && Array.isArray(r.moves) && !!r.white?.id && !!r.black?.id && typeof r.endedAt === "number";

  const ingestRecords = (from: PeerLink, records: GameRecord[]): void => {
    const fresh = (records ?? []).filter((r) => isRecord(r) && store.addRecord(r));
    if (!fresh.length) return;
    if (fresh.length > 20) broadcast({ type: "history", records: store.records });
    else for (const record of fresh) broadcast({ type: "record", record });
    toPeers(from, { type: "records", records: fresh });
  };

  const ingestChat = (from: PeerLink, messages: ChatMessage[]): void => {
    const fresh = store.addChat(...(messages ?? []));
    if (!fresh.length) return;
    if (fresh.length > 20) broadcast({ type: "chatHistory", messages: store.chat });
    else for (const message of fresh) broadcast({ type: "chat", message });
    toPeers(from, { type: "chat", messages: fresh });
  };

  const ingestPlayers = (from: PeerLink, players: KnownPlayer[]): void => {
    if (!store.mergePlayers(players ?? [])) return;
    broadcastPlayers();
    toPeers(from, { type: "players", players: [...store.players.values()] });
  };

  const handlePeer = (link: PeerLink, msg: PeerMessage): void => {
    switch (msg.type) {
      case "peerHello":
        if (msg.protocol !== PROTOCOL || msg.nodeId === store.meta.hubId) return link.ws.close();
        link.nodeId = msg.nodeId;
        return;
      case "have": {
        const theirs = new Set(msg.records ?? []);
        const missing = store.records.filter((r) => !theirs.has(r.id));
        for (let i = 0; i < missing.length; i += PEER_BATCH) {
          sendPeer(link, { type: "records", records: missing.slice(i, i + PEER_BATCH) });
        }
        const theirChat = new Set(msg.chat ?? []);
        const chat = store.chat.filter((m) => !theirChat.has(m.id));
        if (chat.length) sendPeer(link, { type: "chat", messages: chat });
        return ingestPlayers(link, msg.players);
      }
      case "records":
        return ingestRecords(link, msg.records);
      case "chat":
        return ingestChat(link, msg.messages);
      case "players":
        return ingestPlayers(link, msg.players);
    }
  };

  const attachPeer = (ws: WebSocket): void => {
    const link: PeerLink = { ws, nodeId: null };
    peerLinks.add(link);
    watch(ws);
    ws.on("message", (data) => {
      try {
        handlePeer(link, JSON.parse(String(data)) as PeerMessage);
      } catch (e) {
        log(`bad peer message: ${(e as Error).message}`);
      }
    });
    ws.on("close", () => peerLinks.delete(link));
    ws.on("error", () => ws.close());
    sendPeer(link, { type: "peerHello", nodeId: store.meta.hubId, protocol: PROTOCOL });
    sendPeer(link, {
      type: "have",
      records: store.recordIds,
      chat: store.chatIdList,
      players: [...store.players.values()],
    });
  };

  const linkTo = (host: string): void => {
    if (outbound?.host === host && outbound.ws.readyState <= WebSocket.OPEN) return;
    unlink();
    const ws = new WebSocket(`ws://${host}/peer`, { maxPayload: PEER_MAX_PAYLOAD, handshakeTimeout: 3000 });
    outbound = { host, ws };
    ws.on("open", () => attachPeer(ws));
    ws.on("error", () => {});
    ws.on("close", () => {
      if (outbound?.ws === ws) outbound = null;
    });
    log(`linking to peer ${host}`);
  };

  function unlink(): void {
    const ws = outbound?.ws;
    outbound = null;
    ws?.close();
  }

  const hasLiveGame = (): boolean => [...sessions.values()].some((s) => !s.over);

  // ---- Liveness ----
  // A computer that sleeps or drops off the Wi-Fi doesn't close its sockets,
  // and TCP can take many minutes to notice. So ping every socket and drop
  // the ones that go quiet: that's what marks a player away within seconds.
  // (Browsers and ws answer pings by themselves.)

  const heard = new WeakMap<WebSocket, number>();
  const watch = (ws: WebSocket): void => {
    const alive = () => heard.set(ws, Date.now());
    alive();
    ws.on("pong", alive);
    ws.on("message", alive);
  };
  const silentMs = opts.silentMs ?? SILENT_MS;
  const heartbeat = setInterval(() => {
    const now = Date.now();
    const sockets = new Set([...wss.clients, ...[...peerLinks].map((l) => l.ws)]);
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (now - (heard.get(ws) ?? now) > silentMs) ws.terminate();
      else ws.ping();
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref?.();

  // ---- HTTP ----

  const serveFile = (res: ServerResponse, file: string): void => {
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Content-Length": statSync(file).size,
      "Cache-Control": "no-cache",
    });
    createReadStream(file).pipe(res);
  };

  const safeJoin = (root: string, rel: string): string | null => {
    const full = normalize(join(root, decodeURIComponent(rel)));
    return full === normalize(root) || full.startsWith(normalize(root) + sep) ? full : null;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://hub");
    if (url.pathname === "/hello") {
      const info: HelloInfo & { hubId: string } = {
        app: "chesslan",
        protocol: PROTOCOL,
        version: opts.appVersion,
        nodeId: store.meta.hubId,
        hubId: store.meta.hubId, // read by 3.0.x apps
        hostName: opts.hostName ?? "ChessLAN",
        liveGame: hasLiveGame(),
        winUpdates: winUpdateAvailable(),
      };
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(info));
      return;
    }
    if (url.pathname === "/reach") {
      // "Can you reach me?": lets a peer learn whether connections work both ways.
      const addr = url.searchParams.get("addr") ?? "";
      if (!/^[\w.-]+:\d+$/.test(addr)) return void res.writeHead(400).end();
      void fetchHello(addr).then((info) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: !!info, nodeId: info?.nodeId ?? null }));
      });
      return;
    }
    if (url.pathname.startsWith("/updates/win/") && opts.updatesDir) {
      const file = safeJoin(opts.updatesDir, url.pathname.slice("/updates/win/".length));
      return file ? serveFile(res, file) : void res.writeHead(400).end();
    }
    if (opts.staticDir) {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = safeJoin(opts.staticDir, rel);
      return file ? serveFile(res, file) : void res.writeHead(400).end();
    }
    res.writeHead(404).end("Not found");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const peerWss = new WebSocketServer({ noServer: true, maxPayload: PEER_MAX_PAYLOAD });
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://hub").pathname;
    if (path === "/ws") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    else if (path === "/peer") peerWss.handleUpgrade(req, socket, head, (ws) => attachPeer(ws));
    else socket.destroy();
  });
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const addr = req.socket.remoteAddress ?? "";
    const conn: Conn = {
      ws,
      windowOpen: false,
      activity: "idle",
      mic: null,
      rtt: 0,
      local: addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1",
    };
    ws.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return send(conn, { type: "error", message: "Bad JSON" });
      }
      try {
        handle(conn, msg);
      } catch (e) {
        log(`error handling ${msg?.type}: ${(e as Error).stack}`);
        send(conn, { type: "error", message: "Hub error" });
      }
    });
    watch(ws);
    ws.on("close", () => onClose(conn));
    ws.on("error", () => ws.close());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? HUB_PORT, opts.host ?? "0.0.0.0", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? HUB_PORT);
  log(`hub listening on ${port}`);

  return {
    port,
    hubId: store.meta.hubId,
    store,
    linkTo,
    unlink,
    linkedTo: () => (outbound?.ws.readyState === WebSocket.OPEN ? outbound.host : null),
    hasLiveGame,
    close: async () => {
      closing = true;
      clearInterval(heartbeat);
      unlink();
      for (const s of sessions.values()) s.dispose();
      for (const t of challengeTimers.values()) clock.clearTimeout(t);
      for (const c of [...wss.clients, ...peerWss.clients]) c.terminate();
      for (const link of peerLinks) link.ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => peerWss.close(() => resolve()));
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Idle keep-alive HTTP connections would otherwise hold close() open.
      server.closeAllConnections();
      await closed;
    },
  };
}
