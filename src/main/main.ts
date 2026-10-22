// Electron main process: window + tray lifecycle, this app's hub, finding
// the other app and electing the referee, notifications, permissions and
// updates (which come from the Mac).
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  dialog,
  ipcMain,
  nativeImage,
  powerSaveBlocker,
  session,
  shell,
  systemPreferences,
} from "electron";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { IPC, type AppConfig, type HubLocation, type TrayAction, type UpdateStatus } from "../shared/bridge";
import { HUB_PORT } from "../shared/protocol";
import { startHub, type Hub } from "../hub/hub";
import { loadConfig, publicConfig, saveConfig } from "./config";
import { localAddresses } from "./discovery";
import { PeerManager } from "./peers";
import { MacUpdater, WindowsUpdater, winUpdatesDir } from "./updates";

const isMac = process.platform === "darwin";
const devServer = process.env.VITE_DEV_SERVER_URL;
const resources = join(__dirname, "..", "..", "resources");

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let windowOpen = false;
let hub: Hub | null = null;
let peers: PeerManager | null = null;
let sleepBlocker: number | null = null;

const isWindows = process.platform === "win32";
const macUpdater = new MacUpdater(sendUpdateStatus);
const windowsUpdater = new WindowsUpdater(sendUpdateStatus);
// A second copy on one machine (tests, development) needs its own port.
const hubPort = Number(process.env.CHESSLAN_PORT) || HUB_PORT;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  void app.whenReady().then(start);
}

function sendUpdateStatus(s: UpdateStatus): void {
  win?.webContents.send(IPC.updateStatus, s);
}

/** "Alex's MacBook Air" rather than "Alexs-MacBook-Air.local". */
function friendlyHostName(): string {
  if (isMac) {
    try {
      return execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim();
    } catch {
      // Fall through.
    }
  }
  return hostname().replace(/\.local$/, "");
}

// ---------- Hub and peers ----------

async function startNode(): Promise<void> {
  try {
    hub = await startHub({
      dataDir: join(app.getPath("userData"), "hub"),
      // Only the Mac mirrors (and serves) the Windows update.
      updatesDir: isMac ? winUpdatesDir() : undefined,
      appVersion: app.getVersion(),
      hostName: friendlyHostName(),
      port: hubPort,
      log: (m) => console.log(`[hub] ${m}`),
    });
  } catch (e) {
    dialog.showErrorBox(
      "ChessLAN can't start",
      `Port ${hubPort} is in use. Is another copy of ChessLAN already running?\n\n${(e as Error).message}`,
    );
    quit();
    return;
  }
  peers = new PeerManager({
    hub,
    preferred: () => [loadConfig().peerAddress, loadConfig().lastPeer],
    remember: (host) => {
      if (loadConfig().lastPeer !== host) saveConfig({ lastPeer: host });
    },
    onChange: (state) => {
      win?.webContents.send(IPC.hubChanged);
      // Windows takes its updates from the Mac peer only.
      if (isWindows && state.updateSource) void windowsUpdater.setSource(state.updateSource.host);
    },
  });
  if (isMac && app.isPackaged) macUpdater.start();
}

async function findHub(): Promise<HubLocation | null> {
  if (!peers) return null;
  await peers.ready;
  const host = peers.state.referee;
  return { url: `ws://${host}/ws`, host };
}

// ---------- Window ----------

function createWindow(show: boolean): void {
  const { bounds } = loadConfig();
  win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 860,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 720,
    minHeight: 540,
    show: false,
    title: "ChessLAN",
    backgroundColor: "#312e2b",
    autoHideMenuBar: true,
    icon: process.platform === "linux" ? join(resources, "icon.png") : undefined,
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      sandbox: true,
      // Stay connected and keep the clock honest while hidden in the tray.
      backgroundThrottling: false,
    },
  });
  if (bounds?.maximized) win.maximize();

  win.on("show", () => setWindowOpen(true));
  win.on("hide", () => setWindowOpen(false));
  win.on("close", (e) => {
    saveBounds();
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!devServer || !url.startsWith(devServer)) e.preventDefault();
  });

  if (devServer) void win.loadURL(devServer);
  else void win.loadFile(join(__dirname, "..", "renderer", "index.html"));
  if (show) win.once("ready-to-show", () => showWindow());
}

function saveBounds(): void {
  if (!win || win.isMinimized()) return;
  const maximized = win.isMaximized();
  saveConfig({ bounds: { ...(maximized ? (loadConfig().bounds ?? win.getNormalBounds()) : win.getBounds()), maximized } });
}

function setWindowOpen(open: boolean): void {
  if (windowOpen === open) return;
  windowOpen = open;
  win?.webContents.send(IPC.visibility, open);
  if (isMac) {
    // Menu-bar app while the window is closed; normal Dock app while open.
    if (open) void app.dock?.show();
    else app.dock?.hide();
  }
}

function showWindow(): void {
  if (!win) return createWindow(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (isMac) app.focus({ steal: true });
}

// ---------- Tray ----------

function trayMenu(): Menu {
  const action = (a: TrayAction) => {
    showWindow();
    win?.webContents.send(IPC.trayAction, a);
  };
  return Menu.buildFromTemplate([
    { label: "Open ChessLAN", click: () => showWindow() },
    { type: "separator" },
    { label: "Challenge: 1 min", click: () => action("challenge-1") },
    { label: "Challenge: 10 min", click: () => action("challenge-10") },
    { type: "separator" },
    {
      label: "Start at login",
      type: "checkbox",
      checked: loadConfig().startAtLogin,
      click: (item) => applyLoginItem(saveConfig({ startAtLogin: item.checked }).startAtLogin),
    },
    { label: "Quit ChessLAN", click: () => quit() },
  ]);
}

function createTray(): void {
  const icon = nativeImage.createFromPath(
    join(resources, isMac ? "trayTemplate.png" : process.platform === "win32" ? "tray.ico" : "tray.png"),
  );
  if (isMac) icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("ChessLAN");
  tray.setContextMenu(trayMenu());
  // Windows: left click opens the app; the menu is on right click.
  if (!isMac) tray.on("click", () => showWindow());
}

function applyLoginItem(enabled: boolean): void {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled, args: ["--hidden"] });
  tray?.setContextMenu(trayMenu());
}

function quit(): void {
  quitting = true;
  app.quit();
}

// ---------- IPC ----------

function registerIpc(): void {
  ipcMain.handle(IPC.getConfig, () => publicConfig());
  ipcMain.handle(IPC.setConfig, async (_e, patch: Partial<AppConfig>) => {
    const before = loadConfig();
    const next = saveConfig(patch);
    if (patch.peerAddress !== undefined && patch.peerAddress !== before.peerAddress) peers?.poke();
    if (patch.startAtLogin !== undefined) applyLoginItem(next.startAtLogin);
    if (patch.player && !before.player) void askForMic();
    return publicConfig(next);
  });
  ipcMain.handle(IPC.findHub, () => findHub());
  ipcMain.handle(IPC.localAddresses, () => localAddresses());
  ipcMain.handle(IPC.isVisible, () => windowOpen);
  ipcMain.on(IPC.showWindow, () => showWindow());
  ipcMain.on(IPC.attention, () => {
    if (isMac) app.dock?.bounce("informational");
    else win?.flashFrame(true);
  });
  ipcMain.on(IPC.notify, (_e, title: string, body: string) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: true });
    n.on("click", () => showWindow());
    n.show();
  });
  ipcMain.on(IPC.setInGame, (_e, inGame: boolean) => {
    windowsUpdater.setInGame(inGame);
    // Don't let the computer (and with it the hub) sleep mid-game; the display may.
    if (inGame && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start("prevent-app-suspension");
    if (!inGame && sleepBlocker !== null) {
      powerSaveBlocker.stop(sleepBlocker);
      sleepBlocker = null;
    }
  });
  ipcMain.on(IPC.checkUpdates, () => {
    if (isMac) void macUpdater.check();
    else void windowsUpdater.check();
  });
  ipcMain.on(IPC.installUpdate, () => {
    quitting = true;
    if (isMac) macUpdater.install();
    else windowsUpdater.install();
  });
  ipcMain.handle(IPC.savePgn, async (_e, filename: string, pgn: string) => {
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: join(app.getPath("documents"), filename.replace(/[\\/:*?"<>|]/g, "_")),
      filters: [{ name: "PGN", extensions: ["pgn"] }],
    });
    if (res.canceled || !res.filePath) return false;
    mkdirSync(join(res.filePath, ".."), { recursive: true });
    writeFileSync(res.filePath, pgn);
    return true;
  });
  ipcMain.on(IPC.openExternal, (_e, url: string) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
  });
}

async function askForMic(): Promise<void> {
  if (isMac && systemPreferences.getMediaAccessStatus("microphone") === "not-determined") {
    await systemPreferences.askForMediaAccess("microphone");
  }
}

// ---------- Startup ----------

async function start(): Promise<void> {
  if (process.platform === "win32") app.setAppUserModelId("com.untag.chesslan");
  // Voice chat needs the microphone; nothing else is ever granted.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media" || permission === "notifications"));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media" || permission === "notifications");

  registerIpc();
  const config = loadConfig();
  applyLoginItem(config.startAtLogin);
  createTray();

  const launchedHidden =
    process.argv.includes("--hidden") || (isMac && app.getLoginItemSettings().wasOpenedAtLogin);
  // First run always shows the window so setup can happen.
  await startNode();
  createWindow(!launchedHidden || !config.player);
  if (isMac && launchedHidden && config.player) app.dock?.hide();
  if (config.player) void askForMic();

  app.on("activate", () => showWindow());
  app.on("before-quit", () => {
    quitting = true;
    saveBounds();
  });
  app.on("will-quit", (e) => {
    if (!hub) return;
    e.preventDefault();
    peers?.stop();
    const h = hub;
    hub = null;
    void h.close().finally(() => app.exit(0));
  });
}
