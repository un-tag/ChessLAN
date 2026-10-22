import { create } from "zustand";
import type { AppConfig, UpdateStatus } from "../../shared/bridge";
import type {
  Challenge,
  ChatMessage,
  ColorChoice,
  GameRecord,
  GameView,
  PlayerPresence,
} from "../../shared/protocol";
import type { TimeControl } from "../../shared/timeControl";

export interface Prefs {
  sound: boolean;
  volume: number; // 0..1
  showLegalMoves: boolean;
  /** Piece to promote to without asking, or "ask" to pick every time. */
  promotion: "q" | "r" | "b" | "n" | "ask";
  premoves: boolean;
  coordinates: boolean;
  animations: boolean;
  micMuted: boolean;
}

const DEFAULT_PREFS: Prefs = {
  sound: true,
  volume: 0.8,
  showLegalMoves: true,
  promotion: "q",
  premoves: true,
  coordinates: true,
  animations: true,
  micMuted: false,
};

const PREFS_KEY = "chesslan.prefs";

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return DEFAULT_PREFS;
  }
}

export type Screen =
  | { name: "setup" }
  | { name: "home" }
  | { name: "game" }
  | { name: "bot"; botId: string; tc: TimeControl | null; color: ColorChoice; key: number }
  | { name: "history" }
  | { name: "replay"; id: string }
  | { name: "stats" }
  | { name: "settings" };

export type ConnState = "idle" | "searching" | "connecting" | "connected" | "mismatch";

export type VoiceStatus = "off" | "waiting" | "connecting" | "connected" | "no-mic";

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

export interface State {
  config: AppConfig | null;
  prefs: Prefs;
  screen: Screen;
  conn: ConnState;
  hub: { hostName: string; hubId: string; version: string; host: string } | null;
  mismatch: { hubVersion: string; winUpdateAvailable: boolean } | null;
  serverOffset: number;
  rtt: number;
  players: PlayerPresence[];
  challenges: Challenge[];
  game: GameView | null;
  records: GameRecord[];
  chat: ChatMessage[];
  unread: number;
  toasts: Toast[];
  windowVisible: boolean;
  update: UpdateStatus;
  voice: VoiceStatus;
  remoteTalking: boolean;
  opponentId: string | null;
  /** A game against the computer is in progress (reported to the other player). */
  botGameLive: boolean;
}

export const useStore = create<State>(() => ({
  config: null,
  prefs: loadPrefs(),
  screen: { name: "home" },
  conn: "idle",
  hub: null,
  mismatch: null,
  serverOffset: 0,
  rtt: 0,
  players: [],
  challenges: [],
  game: null,
  records: [],
  chat: [],
  unread: 0,
  toasts: [],
  windowVisible: true,
  update: { state: "idle" },
  voice: "off",
  remoteTalking: false,
  opponentId: null,
  botGameLive: false,
}));

export const get = useStore.getState;
export const set = useStore.setState;

export function setPrefs(patch: Partial<Prefs>): void {
  const prefs = { ...get().prefs, ...patch };
  set({ prefs });
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Not persisted; fine for this session.
  }
}

let toastId = 0;
export function toast(text: string, kind: Toast["kind"] = "info"): void {
  const id = ++toastId;
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4500);
}

export function navigate(screen: Screen): void {
  set({ screen });
}

export const myId = (): string => get().config?.player?.id ?? "";

/** The other human player: the chosen one, else the most relevant known player. */
export function opponent(s: State = get()): PlayerPresence | null {
  const me = s.config?.player?.id;
  const others = s.players.filter((p) => p.id !== me);
  return (
    others.find((p) => p.id === s.opponentId) ??
    others.find((p) => p.online && p.windowOpen) ??
    others.find((p) => p.online) ??
    others[0] ??
    null
  );
}

/** Hub time now, estimated from ping/pong. */
export const serverNow = (): number => Date.now() + get().serverOffset;
