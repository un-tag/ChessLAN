// Contract between the Electron main process (exposed via preload as
// `window.chesslan`) and the renderer. In a plain browser the renderer
// provides its own fallback implementation.
import type { PlayerRef } from "./protocol";

export interface AppConfig {
  player: PlayerRef | null;
  /** The other computer's address, only if discovery ever needs help ("192.168.1.20" or "mac.local:47800"). */
  peerAddress: string | null;
  startAtLogin: boolean;
}

export interface HubLocation {
  url: string; // ws://host:port/ws
  host: string;
}

export type TrayAction = "open" | "challenge-1" | "challenge-10";

export interface UpdateStatus {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  version?: string;
  progress?: number;
  message?: string;
}

export interface DesktopBridge {
  platform: string;
  appVersion: string;
  getConfig(): Promise<AppConfig>;
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  /** The hub to use: the elected referee's, or this app's own when alone. */
  findHub(): Promise<HubLocation | null>;
  /** The referee changed: reconnect (findHub has the new answer). */
  onHubChanged(cb: () => void): () => void;
  getLocalAddresses(): Promise<string[]>;
  isVisible(): Promise<boolean>;
  onVisibility(cb: (visible: boolean) => void): () => void;
  showWindow(): void;
  attention(): void;
  notify(title: string, body: string): void;
  setInGame(inGame: boolean): void;
  onTrayAction(cb: (action: TrayAction) => void): () => void;
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void;
  checkForUpdates(): void;
  installUpdate(): void;
  savePgn(filename: string, pgn: string): Promise<boolean>;
  openExternal(url: string): void;
}

export const IPC = {
  getConfig: "config:get",
  setConfig: "config:set",
  findHub: "hub:find",
  hubChanged: "hub:changed",
  localAddresses: "hub:addresses",
  isVisible: "window:isVisible",
  visibility: "window:visibility",
  showWindow: "window:show",
  attention: "window:attention",
  notify: "notify",
  setInGame: "state:inGame",
  trayAction: "tray:action",
  updateStatus: "update:status",
  checkUpdates: "update:check",
  installUpdate: "update:install",
  savePgn: "pgn:save",
  openExternal: "open:external",
} as const;
