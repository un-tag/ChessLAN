// The desktop bridge when running in Electron, or a browser fallback (used
// for development and the end-to-end tests, where the hub serves this UI).
import type { AppConfig, DesktopBridge, HubLocation } from "../shared/bridge";
import { HUB_PORT } from "../shared/protocol";

declare global {
  interface Window {
    chesslan?: DesktopBridge;
  }
}

const CONFIG_KEY = "chesslan.config";

function webBridge(): DesktopBridge {
  const params = new URLSearchParams(location.search);
  const read = (): AppConfig => {
    let stored: Partial<AppConfig> = {};
    try {
      stored = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}");
    } catch {
      // Storage unavailable: run with defaults.
    }
    const config: AppConfig = { player: null, peerAddress: null, startAtLogin: false, ...stored };
    // Tests and dev can preset the player: ?id=alex&name=Alex
    if (params.get("id") && params.get("name")) config.player = { id: params.get("id")!, name: params.get("name")! };
    return config;
  };
  const noop = () => () => {};
  return {
    platform: "web",
    appVersion: __APP_VERSION__,
    getConfig: async () => read(),
    setConfig: async (patch) => {
      const next = { ...read(), ...patch };
      try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
      } catch {
        // Ignore: the session still works, it just won't be remembered.
      }
      return next;
    },
    findHub: async (): Promise<HubLocation> => {
      const host = params.get("hub") ?? (location.port ? location.host : `${location.hostname}:${HUB_PORT}`);
      return { url: `ws://${host}/ws`, host };
    },
    onHubChanged: noop,
    getLocalAddresses: async () => [location.hostname],
    isVisible: async () => true,
    onVisibility: noop,
    showWindow: () => window.focus(),
    attention: () => {},
    notify: (title, body) => {
      if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
        new Notification(title, { body });
      }
    },
    setInGame: () => {},
    onTrayAction: noop,
    onUpdateStatus: noop,
    checkForUpdates: () => {},
    installUpdate: () => {},
    savePgn: async (filename, pgn) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([pgn], { type: "application/x-chess-pgn" }));
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return true;
    },
    openExternal: (url) => window.open(url, "_blank"),
  };
}

export const platform: DesktopBridge = window.chesslan ?? webBridge();
export const isDesktop = !!window.chesslan;
