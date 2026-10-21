// The hub runs on the host Mac and is the single source of truth: it relays
// challenges, runs every game session, keeps chat and the game log, relays
// WebRTC signalling for voice and serves Windows update files.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Side } from "../shared/chess/game";
import {
  CHALLENGE_TTL_MS,
  HUB_PORT,
  PROTOCOL,
  type Activity,
  type Challenge,
  type ClientMessage,
  type GameRecord,
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
}

export interface Hub {
  port: number;
  hubId: string;
  store: Store;
  close(): Promise<void>;
}

interface Conn {
  ws: WebSocket;
  player?: PlayerRef;
  windowOpen: boolean;
  activity: Activity;
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
        isHost: c?.local ?? false,
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
        conn.activity = msg.activity;
        return broadcastPlayers();
      case "ping":
        if (typeof msg.rtt === "number" && msg.rtt >= 0) conn.rtt = conn.rtt ? conn.rtt * 0.7 + msg.rtt * 0.3 : msg.rtt;
        return send(conn, { type: "pong", t: msg.t, serverTime: clock.now() });
      case "challenge": {
        const target = store.players.get(msg.to);
        if (!target || !conns.has(msg.to) || msg.to === me.id) {
          return send(conn, { type: "error", message: "They're not online right now" });
        }
        if (activeSessionOf(me.id)) return send(conn, { type: "error", message: "Finish your current game first" });
        if (activeSessionOf(msg.to)) return send(conn, { type: "error", message: `${target.name} is in a game` });
        for (const ch of [...challenges.values()]) if (ch.from.id === me.id) removeChallenge(ch.id);
        const ch: Challenge = {
          id: randomUUID(),
          from: me,
          to: { id: target.id, name: target.name },
          tc: msg.spec.tc,
          color: msg.spec.color,
          rated: msg.spec.rated && !!msg.spec.tc,
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
        const challengerWhite =
          ch.color === "white" ? true : ch.color === "black" ? false : Math.random() < 0.5;
        const [white, black] = challengerWhite ? [ch.from, ch.to] : [ch.to, ch.from];
        createSession(white, black, ch.tc, ch.rated);
        return;
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
        if (store.addRecord(record)) broadcast({ type: "record", record });
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
    for (const ch of [...challenges.values()]) if (ch.from.id === p.id) removeChallenge(ch.id);
    activeSessionOf(p.id)?.playerLeft(p.id);
    sendChallenges();
    broadcastPlayers();
    log(`${p.name} disconnected`);
  };

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
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(
        JSON.stringify({
          app: "chesslan",
          protocol: PROTOCOL,
          version: opts.appVersion,
          hubId: store.meta.hubId,
          hostName: opts.hostName ?? "Host",
        }),
      );
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

  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 256 * 1024 });
  // The WebSocket server re-emits HTTP server errors (e.g. port in use);
  // those are reported through the listen promise below instead.
  wss.on("error", () => {});
  wss.on("connection", (ws, req) => {
    const addr = req.socket.remoteAddress ?? "";
    const conn: Conn = {
      ws,
      windowOpen: false,
      activity: "idle",
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
    close: async () => {
      closing = true;
      for (const s of sessions.values()) s.dispose();
      for (const t of challengeTimers.values()) clock.clearTimeout(t);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Idle keep-alive HTTP connections would otherwise hold close() open.
      server.closeAllConnections();
      await closed;
    },
  };
}
