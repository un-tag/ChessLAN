// The single WebSocket to the hub: discovery, reconnects, clock sync and
// dispatching server messages into the store.
import {
  CHALLENGE_TTL_MS,
  HEARTBEAT_MS,
  PROTOCOL,
  SILENT_MS,
  type Challenge,
  type ChallengeSpec,
  type ClientMessage,
  type GameRecord,
  type ServerMessage,
} from "../../shared/protocol";
import { platform } from "../platform";
import { sounds } from "../sound";
import { get, myId, navigate, set, toast } from "../state/store";
import { voice } from "../voice";

const PENDING_KEY = "chesslan.pendingRecords";

type Listener = (msg: ServerMessage) => void;

class Connection {
  private ws: WebSocket | null = null;
  private retryMs = 500;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** When we started waiting for the hub to answer (0: it has). */
  private unansweredSince = 0;
  private started = false;
  private bestRtt = Infinity;
  private listeners = new Set<Listener>();
  // Our pending challenge, so it can be re-sent if we move to another hub
  // (the other app turned up and became referee) before it was answered.
  private outgoing: { to: string; spec: ChallengeSpec; at: number; seen: boolean } | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.connect();
  }

  /** Subscribe to raw server messages (used by the game screen). */
  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    if (msg.type === "challenge") this.outgoing = { to: msg.to, spec: msg.spec, at: Date.now(), seen: false };
    if (msg.type === "challengeCancel") this.outgoing = null;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Drops the connection and reconnects soon (the referee changed, or the name). */
  restart(): void {
    this.retryMs = 200;
    if (this.ws) this.drop(this.ws);
    else if (this.started) void this.connect();
  }

  /**
   * Gives up on a socket now. Closing a dead one (the hub's computer went
   * to sleep) can take a minute to report, so don't wait for it.
   */
  private drop(ws: WebSocket): void {
    this.lost(ws);
    ws.close();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && get().conn === "connected";
  }

  private async connect(): Promise<void> {
    set({ conn: "searching" });
    let loc = null;
    try {
      loc = await platform.findHub();
    } catch {
      loc = null;
    }
    if (!loc) return this.retry();
    set({ conn: "connecting" });
    const ws = new WebSocket(loc.url);
    this.ws = ws;
    ws.onopen = () => {
      const player = get().config?.player;
      if (!player) return ws.close();
      ws.send(
        JSON.stringify({
          type: "hello",
          protocol: PROTOCOL,
          appVersion: platform.appVersion,
          player,
          platform: platform.platform,
        } satisfies ClientMessage),
      );
      set({ hub: { hostName: "", hubId: "", version: "", host: loc!.host } });
    };
    ws.onmessage = (e) => {
      if (this.ws === ws) this.unansweredSince = 0;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      handle(msg);
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = (e) => this.lost(ws, e.code);
  }

  private lost(ws: WebSocket, code?: number): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.stopPing();
    voice.reset();
    if (code === 4000) {
      // The hub replaced us with a newer connection for the same player
      // (the app opened elsewhere). Reconnecting would just kick that one off.
      set({ conn: "idle", players: [], challenges: [] });
      toast("ChessLAN was opened somewhere else for this player", "error");
      return;
    }
    if (get().conn !== "mismatch") set({ conn: "searching", players: [], challenges: [] });
    this.retry();
  }

  private retry(): void {
    const wait = this.retryMs;
    this.retryMs = Math.min(5000, this.retryMs * 2);
    setTimeout(() => void this.connect(), wait);
  }

  onWelcome(): void {
    this.retryMs = 500;
    this.bestRtt = Infinity;
    this.sendPresence();
    this.startPing();
    flushPendingRecords();
    const out = this.outgoing;
    if (out && Date.now() - out.at < CHALLENGE_TTL_MS) {
      out.seen = false;
      this.ws?.send(JSON.stringify({ type: "challenge", to: out.to, spec: out.spec } satisfies ClientMessage));
    } else {
      this.outgoing = null;
    }
  }

  /** Forget our pending challenge once it's gone from the hub (answered, expired). */
  trackChallenges(list: Challenge[]): void {
    if (!this.outgoing) return;
    if (list.some((c) => c.from.id === myId())) this.outgoing.seen = true;
    else if (this.outgoing.seen) this.outgoing = null;
  }

  challengeSettled(): void {
    this.outgoing = null;
  }

  sendPresence(): void {
    // Being in a game against each other is known to the hub already.
    const { botGameLive, windowVisible, mic } = get();
    this.send({ type: "presence", windowOpen: windowVisible, activity: botGameLive ? "bot" : "idle", mic });
  }

  /** Pings for clock sync, and reconnects if the hub stops answering. */
  private startPing(): void {
    this.stopPing();
    this.unansweredSince = 0;
    const ping = () => {
      const ws = this.ws;
      if (!ws) return;
      if (this.unansweredSince && Date.now() - this.unansweredSince > SILENT_MS) return this.drop(ws);
      // Timed from the ping, so a throttled timer can't look like silence.
      if (!this.unansweredSince) this.unansweredSince = Date.now();
      this.send({ type: "ping", t: Date.now(), rtt: get().rtt || undefined });
    };
    ping();
    this.pingTimer = setInterval(ping, HEARTBEAT_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  onPong(t: number, serverTime: number): void {
    const now = Date.now();
    const rtt = now - t;
    const s = get();
    set({ rtt: s.rtt ? Math.round(s.rtt * 0.7 + rtt * 0.3) : rtt });
    // Trust the offset from the fastest round trip seen (least asymmetric).
    if (rtt <= this.bestRtt * 1.5 || rtt < 20) {
      this.bestRtt = Math.min(this.bestRtt, rtt);
      set({ serverOffset: serverTime - (t + rtt / 2) });
    }
  }
}

export const connection = new Connection();

function handle(msg: ServerMessage): void {
  const s = get();
  switch (msg.type) {
    case "welcome":
      set({
        conn: "connected",
        mismatch: null,
        serverOffset: msg.serverTime - Date.now(),
        hub: { hostName: msg.hostName, hubId: msg.hubId, version: msg.appVersion, host: s.hub?.host ?? "" },
      });
      connection.onWelcome();
      return;
    case "versionMismatch":
      set({ conn: "mismatch", mismatch: { hubVersion: msg.hubVersion, winUpdateAvailable: msg.winUpdateAvailable } });
      platform.checkForUpdates();
      return;
    case "pong":
      return connection.onPong(msg.t, msg.serverTime);
    case "players":
      set({ players: msg.players });
      voice.update();
      return;
    case "challenges": {
      const before = new Set(s.challenges.map((c) => c.id));
      set({ challenges: msg.challenges });
      connection.trackChallenges(msg.challenges);
      const incoming = msg.challenges.find((c) => c.to.id === myId() && !before.has(c.id));
      if (incoming) {
        sounds.notify();
        platform.showWindow();
        platform.attention();
        platform.notify("Chess challenge", `${incoming.from.name} wants to play`);
      }
      return;
    }
    case "challengeDeclined":
      connection.challengeSettled();
      return toast(`${msg.by.name} declined your challenge`);
    case "game": {
      const g = msg.game;
      if (g.white.id !== myId() && g.black.id !== myId()) return;
      // A finished game never replaces a different live one (e.g. the old
      // game's "rematch started" update arriving after the new game).
      if (s.game && s.game.id !== g.id && !s.game.over && g.over) return;
      const isNew = s.game?.id !== g.id;
      if (isNew && !g.over) {
        connection.challengeSettled();
        // A new game (accepted challenge or rematch) always takes over the screen.
        set({ game: g });
        navigate({ name: "game" });
        sounds.start();
        platform.showWindow();
        connection.sendPresence();
        return;
      }
      set({ game: g });
      return;
    }
    case "history":
      return set({ records: msg.records });
    case "record": {
      const records = s.records.some((r) => r.id === msg.record.id) ? s.records : [...s.records, msg.record];
      set({ records });
      removePendingRecord(msg.record.id);
      return;
    }
    case "chatHistory":
      return set({ chat: msg.messages });
    case "chat": {
      set({ chat: [...s.chat.slice(-499), msg.message] });
      if (msg.message.from.id !== myId()) {
        set({ unread: s.unread + 1 });
        sounds.chat();
        if (!s.windowVisible) platform.notify(msg.message.from.name, msg.message.text);
      }
      return;
    }
    case "rtc":
      void voice.signal(msg.from, msg.data);
      return;
    case "error":
      return toast(msg.message, "error");
  }
}

// ---- Bot games are saved to the hub; queue them while it's unreachable ----

function readPending(): GameRecord[] {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function writePending(list: GameRecord[]): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {
    // Storage full or unavailable; the record is lost but play goes on.
  }
}

export function saveRecord(record: GameRecord): void {
  writePending([...readPending(), record]);
  set((s) => ({ records: s.records.some((r) => r.id === record.id) ? s.records : [...s.records, record] }));
  connection.send({ type: "saveRecord", record });
}

function flushPendingRecords(): void {
  for (const record of readPending()) connection.send({ type: "saveRecord", record });
}

function removePendingRecord(id: string): void {
  const list = readPending();
  if (list.some((r) => r.id === id)) writePending(list.filter((r) => r.id !== id));
}
