// Updates come from the Mac, without anyone doing anything:
// - Mac: when online, checks GitHub Releases. A newer version is downloaded
//   and swapped in on restart (unsigned apps can't use Squirrel.Mac). It also
//   mirrors the Windows installer for its *own* version into its hub's
//   /updates/win feed.
// - Windows: electron-updater with the Mac peer's hub as its feed, so the
//   Windows app always converges on the Mac's version over the LAN.
import { app } from "electron";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UpdateStatus } from "../shared/bridge";

const REPO = "un-tag/ChessLAN";
const API = `https://api.github.com/repos/${REPO}/releases`;

interface Asset {
  name: string;
  browser_download_url: string;
}
interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: Asset[];
}

export const winUpdatesDir = (): string => join(app.getPath("userData"), "updates", "win");

export function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "ChessLAN" } });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null; // Offline is normal.
  }
}

async function download(url: string, dest: string, onProgress?: (pct: number) => void): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": "ChessLAN" } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let got = 0;
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const body = Readable.fromWeb(res.body as never);
  body.on("data", (chunk: Buffer) => {
    got += chunk.length;
    if (total) onProgress?.((got / total) * 100);
  });
  await pipeline(body, createWriteStream(tmp));
  renameSync(tmp, dest);
}

export class MacUpdater {
  status: UpdateStatus = { state: "idle" };
  private readyApp: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private onStatus: (s: UpdateStatus) => void) {}

  private set(s: UpdateStatus): void {
    this.status = s;
    this.onStatus(s);
  }

  start(): void {
    setTimeout(() => void this.check(), 15_000);
    this.timer = setInterval(() => void this.check(), 6 * 3600_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(): Promise<void> {
    if (this.status.state === "checking" || this.status.state === "downloading" || this.readyApp) return;
    this.set({ state: "checking" });
    await this.mirrorWindows(app.getVersion());
    const latest = await getJson<Release>(`${API}/latest`);
    if (!latest || !newer(latest.tag_name, app.getVersion())) return this.set({ state: "idle" });
    const version = latest.tag_name.replace(/^v/, "");
    const zip = latest.assets.find((a) => /-arm64-mac\.zip$/.test(a.name));
    if (process.platform !== "darwin" || !zip) return this.set({ state: "available", version });
    try {
      const dir = join(app.getPath("userData"), "pending-update");
      rmSync(dir, { recursive: true, force: true });
      const zipPath = join(dir, zip.name);
      await download(zip.browser_download_url, zipPath, (progress) => this.set({ state: "downloading", version, progress }));
      await run("ditto", ["-x", "-k", zipPath, dir]);
      const extracted = join(dir, "ChessLAN.app");
      if (!existsSync(extracted)) throw new Error("Update archive had no app");
      this.readyApp = extracted;
      this.set({ state: "ready", version });
    } catch (e) {
      this.set({ state: "error", version, message: (e as Error).message });
    }
  }

  /** Keeps the Windows feed for `version` on disk so the joiner can update over the LAN. */
  private async mirrorWindows(version: string): Promise<void> {
    const dir = winUpdatesDir();
    if (existsSync(join(dir, `ChessLAN-Setup-${version}.exe`)) && existsSync(join(dir, "latest.yml"))) return;
    const release = await getJson<Release>(`${API}/tags/v${version}`);
    if (!release) return;
    const files = release.assets.filter(
      (a) => a.name === `ChessLAN-Setup-${version}.exe` || a.name === `ChessLAN-Setup-${version}.exe.blockmap`,
    );
    const yml = release.assets.find((a) => a.name === "latest.yml");
    if (!yml || !files.some((f) => f.name.endsWith(".exe"))) return;
    try {
      rmSync(dir, { recursive: true, force: true });
      for (const f of files) await download(f.browser_download_url, join(dir, f.name));
      // latest.yml last: its presence means the feed is complete.
      await download(yml.browser_download_url, join(dir, "latest.yml"));
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Swaps the app bundle after we quit, then relaunches. */
  install(): void {
    if (!this.readyApp) return;
    const bundle = join(dirname(app.getPath("exe")), "..", "..");
    if (!bundle.endsWith(".app")) return;
    // If the new bundle can't be moved in, put the old one back.
    const script = `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done
rm -rf "${bundle}.old"
if mv "${bundle}" "${bundle}.old"; then
  if mv "${this.readyApp}" "${bundle}"; then rm -rf "${bundle}.old"; else mv "${bundle}.old" "${bundle}"; fi
fi
open "${bundle}"`;
    spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" }).unref();
    app.quit();
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "ignore" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

/** Windows: follows the Mac's version via the Mac hub's update feed. */
export class WindowsUpdater {
  status: UpdateStatus = { state: "idle" };
  private feed: string | null = null;
  private inGame = false;
  private downloaded = false;
  private updater: typeof import("electron-updater").autoUpdater | null = null;

  constructor(private onStatus: (s: UpdateStatus) => void) {}

  private set(s: UpdateStatus): void {
    this.status = s;
    this.onStatus(s);
  }

  private async load() {
    if (this.updater) return this.updater;
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", () => this.set({ state: "checking" }));
    autoUpdater.on("update-not-available", () => this.set({ state: "idle" }));
    autoUpdater.on("update-available", (i) => this.set({ state: "downloading", version: i.version, progress: 0 }));
    autoUpdater.on("download-progress", (p) => this.set({ ...this.status, state: "downloading", progress: p.percent }));
    autoUpdater.on("update-downloaded", (i) => {
      this.downloaded = true;
      this.set({ state: "ready", version: i.version });
      this.maybeInstall();
    });
    autoUpdater.on("error", (e) => this.set({ state: "error", message: String(e?.message ?? e) }));
    this.updater = autoUpdater;
    return autoUpdater;
  }

  /** Called whenever the Mac peer (the update source) is (re)discovered. */
  async setSource(host: string): Promise<void> {
    if (!app.isPackaged || process.platform !== "win32") return;
    const feed = `http://${host}/updates/win`;
    const u = await this.load();
    if (feed !== this.feed) {
      this.feed = feed;
      u.setFeedURL({ provider: "generic", url: feed });
    }
    void this.check();
  }

  async check(): Promise<void> {
    if (!this.feed || this.downloaded) return;
    try {
      await (await this.load()).checkForUpdates();
    } catch (e) {
      this.set({ state: "error", message: (e as Error).message });
    }
  }

  setInGame(inGame: boolean): void {
    this.inGame = inGame;
    this.maybeInstall();
  }

  /** Never interrupt a game; otherwise install silently and relaunch. */
  private maybeInstall(): void {
    if (!this.downloaded || this.inGame) return;
    setTimeout(() => {
      if (!this.inGame) this.updater?.quitAndInstall(true, true);
    }, 1500);
  }

  install(): void {
    if (this.downloaded) this.updater?.quitAndInstall(true, true);
  }
}
