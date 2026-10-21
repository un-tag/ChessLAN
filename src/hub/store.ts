// Hub persistence: an append-only game log plus small JSON files for
// players and chat. Everything lives in one data directory.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessage, GameRecord, PlayerRef } from "../shared/protocol";

export const CHAT_LIMIT = 500;

interface HubMeta {
  hubId: string;
  createdAt: number;
}

export class Store {
  readonly records: GameRecord[] = [];
  readonly chat: ChatMessage[] = [];
  readonly players = new Map<string, PlayerRef & { lastSeen: number }>();
  readonly meta: HubMeta;
  private ids = new Set<string>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    this.meta = this.readJson<HubMeta>("hub.json") ?? { hubId: randomUUID(), createdAt: Date.now() };
    this.writeJson("hub.json", this.meta);
    this.loadGames();
    this.chat.push(...(this.readJson<ChatMessage[]>("chat.json") ?? []).slice(-CHAT_LIMIT));
    for (const p of this.readJson<(PlayerRef & { lastSeen: number })[]>("players.json") ?? []) {
      this.players.set(p.id, p);
    }
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  private readJson<T>(name: string): T | null {
    try {
      return JSON.parse(readFileSync(this.path(name), "utf8")) as T;
    } catch {
      return null;
    }
  }

  // Write to a temp file then rename, so a crash never leaves half a file.
  private writeJson(name: string, value: unknown): void {
    const tmp = this.path(`${name}.tmp`);
    writeFileSync(tmp, JSON.stringify(value, null, 1));
    renameSync(tmp, this.path(name));
  }

  private loadGames(): void {
    const file = this.path("games.jsonl");
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as GameRecord;
        if (!this.ids.has(r.id)) {
          this.ids.add(r.id);
          this.records.push(r);
        }
      } catch {
        // A torn last line from a crash: skip it.
      }
    }
  }

  /** Appends a record; returns false if a record with that id already exists. */
  addRecord(r: GameRecord): boolean {
    if (this.ids.has(r.id)) return false;
    this.ids.add(r.id);
    this.records.push(r);
    appendFileSync(this.path("games.jsonl"), JSON.stringify(r) + "\n");
    return true;
  }

  addChat(m: ChatMessage): void {
    this.chat.push(m);
    if (this.chat.length > CHAT_LIMIT) this.chat.splice(0, this.chat.length - CHAT_LIMIT);
    this.writeJson("chat.json", this.chat);
  }

  touchPlayer(p: PlayerRef): void {
    this.players.set(p.id, { id: p.id, name: p.name, lastSeen: Date.now() });
    this.writeJson("players.json", [...this.players.values()]);
  }
}
