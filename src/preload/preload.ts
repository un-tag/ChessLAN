// Exposes the desktop bridge to the renderer (context-isolated, sandboxed).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type DesktopBridge } from "../shared/bridge";

declare const __APP_VERSION__: string;

function listen<T>(channel: string, cb: (value: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const bridge: DesktopBridge = {
  platform: process.platform,
  appVersion: __APP_VERSION__,
  getConfig: () => ipcRenderer.invoke(IPC.getConfig),
  setConfig: (patch) => ipcRenderer.invoke(IPC.setConfig, patch),
  findHub: () => ipcRenderer.invoke(IPC.findHub),
  onHubChanged: (cb) => listen(IPC.hubChanged, () => cb()),
  getLocalAddresses: () => ipcRenderer.invoke(IPC.localAddresses),
  isVisible: () => ipcRenderer.invoke(IPC.isVisible),
  onVisibility: (cb) => listen(IPC.visibility, cb),
  showWindow: () => ipcRenderer.send(IPC.showWindow),
  attention: () => ipcRenderer.send(IPC.attention),
  notify: (title, body) => ipcRenderer.send(IPC.notify, title, body),
  setInGame: (inGame) => ipcRenderer.send(IPC.setInGame, inGame),
  onTrayAction: (cb) => listen(IPC.trayAction, cb),
  onUpdateStatus: (cb) => listen(IPC.updateStatus, cb),
  checkForUpdates: () => ipcRenderer.send(IPC.checkUpdates),
  installUpdate: () => ipcRenderer.send(IPC.installUpdate),
  savePgn: (filename, pgn) => ipcRenderer.invoke(IPC.savePgn, filename, pgn),
  openExternal: (url) => ipcRenderer.send(IPC.openExternal, url),
};

contextBridge.exposeInMainWorld("chesslan", bridge);
