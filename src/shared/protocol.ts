// Messages between the hub (on the host Mac) and each app's renderer.
// Everything travels as JSON over one WebSocket per player.
import type { EndReason, Result, Side } from "./chess/game";
import type { Category, TimeControl } from "./timeControl";

export const PROTOCOL = 1;
export const HUB_PORT = 47800;
export const ABANDON_MS = 60_000;
/** How long a challenge waits, including for a player whose app isn't running yet. */
export const CHALLENGE_TTL_MS = 10 * 60_000;

export interface PlayerRef {
  id: string;
  name: string;
}

export interface BotRef {
  id: string;
  name: string;
  rating: number;
}

/** One finished game. The hub's game log is the source of truth for history and ratings. */
export interface GameRecord {
  id: string;
  white: PlayerRef;
  black: PlayerRef;
  tc: TimeControl | null;
  category: Category;
  rated: boolean;
  moves: string[]; // UCI
  result: Result;
  reason: EndReason;
  startedAt: number;
  endedAt: number;
  bot?: BotRef & { side: Side };
}

/** "game" is decided by the hub from live games; apps only report "idle" or "bot". */
export type Activity = "idle" | "game" | "bot";

export interface PlayerPresence extends PlayerRef {
  online: boolean;
  windowOpen: boolean;
  activity: Activity;
  isHost: boolean;
}

export type ColorChoice = "white" | "black" | "random";

export interface ChallengeSpec {
  tc: TimeControl | null;
  color: ColorChoice; // from the challenger's point of view
  rated: boolean;
}

export interface Challenge extends ChallengeSpec {
  id: string;
  from: PlayerRef;
  to: PlayerRef;
  createdAt: number;
}

export interface ClockView {
  w: number; // remaining ms at `at`
  b: number;
  running: Side | null;
  at: number; // hub time of this snapshot
}

export interface RatingChange {
  category: Category;
  w: { before: number; after: number };
  b: { before: number; after: number };
}

/** Full snapshot of a live (or just finished) game. Sent on every change. */
export interface GameView {
  id: string;
  white: PlayerRef;
  black: PlayerRef;
  tc: TimeControl | null;
  rated: boolean;
  moves: string[];
  clock: ClockView | null;
  over: boolean;
  result?: Result;
  reason?: EndReason | "aborted";
  drawOffer: Side | null;
  takeback: Side | null;
  rematch: Side[];
  disconnected: { side: Side; deadline: number } | null;
  startedAt: number;
  ratingChange?: RatingChange;
  nextGameId?: string;
}

export interface ChatMessage {
  id: string;
  from: PlayerRef;
  text: string;
  at: number;
}

export interface UpdateInfo {
  hubVersion: string;
  winUpdateAvailable: boolean;
}

export type ClientMessage =
  | { type: "hello"; protocol: number; appVersion: string; player: PlayerRef; platform: string }
  | { type: "presence"; windowOpen: boolean; activity: Activity }
  | { type: "ping"; t: number; rtt?: number }
  | { type: "challenge"; to: string; spec: ChallengeSpec }
  | { type: "challengeCancel"; id: string }
  | { type: "challengeRespond"; id: string; accept: boolean }
  | { type: "move"; gameId: string; uci: string; ply: number; thinkMs?: number }
  | { type: "resign"; gameId: string }
  | { type: "abort"; gameId: string }
  | { type: "drawOffer"; gameId: string }
  | { type: "drawRespond"; gameId: string; accept: boolean }
  | { type: "takebackRequest"; gameId: string }
  | { type: "takebackRespond"; gameId: string; accept: boolean }
  | { type: "rematch"; gameId: string }
  | { type: "chat"; text: string }
  | { type: "rtc"; to: string; data: unknown }
  | { type: "saveRecord"; record: GameRecord };

export type ServerMessage =
  | {
      type: "welcome";
      you: string;
      hubId: string;
      hostName: string;
      serverTime: number;
      appVersion: string;
      update: UpdateInfo;
    }
  | { type: "versionMismatch"; hubProtocol: number; hubVersion: string; winUpdateAvailable: boolean }
  | { type: "pong"; t: number; serverTime: number }
  | { type: "players"; players: PlayerPresence[] }
  | { type: "challenges"; challenges: Challenge[] }
  | { type: "challengeDeclined"; id: string; by: PlayerRef }
  | { type: "game"; game: GameView }
  | { type: "history"; records: GameRecord[] }
  | { type: "record"; record: GameRecord }
  | { type: "chatHistory"; messages: ChatMessage[] }
  | { type: "chat"; message: ChatMessage }
  | { type: "rtc"; from: string; data: unknown }
  | { type: "error"; message: string };
