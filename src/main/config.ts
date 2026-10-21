import { app } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig } from "../shared/bridge";

export interface MainConfig extends AppConfig {
  /** Last hub address that worked ("192.168.1.20:47800"), tried first next time. */
  lastHub: string | null;
  bounds: { x?: number; y?: number; width: number; height: number; maximized?: boolean } | null;
}

const DEFAULTS: MainConfig = {
  player: null,
  role: null,
  hubAddress: null,
  // Challenges can only pop up if the app is running, so start at login by default.
  startAtLogin: true,
  lastHub: null,
  bounds: null,
};

const file = () => join(app.getPath("userData"), "config.json");

let cache: MainConfig | null = null;

export function loadConfig(): MainConfig {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(readFileSync(file(), "utf8")) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache!;
}

export function saveConfig(patch: Partial<MainConfig>): MainConfig {
  cache = { ...loadConfig(), ...patch };
  mkdirSync(dirname(file()), { recursive: true });
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, file());
  return cache;
}

/** The subset the renderer sees. */
export function publicConfig(c: MainConfig = loadConfig()): AppConfig {
  return { player: c.player, role: c.role, hubAddress: c.hubAddress, startAtLogin: c.startAtLogin };
}
