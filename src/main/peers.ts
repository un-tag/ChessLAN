// Keeps track of the other ChessLAN app and decides which hub referees.
// Both apps run this same logic and reach the same answer:
//   - a hub with a live game stays referee (never strand a game);
//   - if only one direction works, the reachable hub referees;
//   - otherwise the smaller node id referees.
// The follower links its hub to the referee's (to sync data) and points its
// UI at the referee. No Electron here, so it can be tested directly.
import type { Hub } from "../hub/hub";
import { PROTOCOL } from "../shared/protocol";
import { addressFacing, findPeer, type Found } from "./discovery";

export type Choice = "self" | "peer";

export function electReferee(o: {
  selfId: string;
  peerId: string;
  peerReachesMe: boolean;
  selfLive: boolean;
  peerLive: boolean;
}): Choice {
  if (o.selfLive) return "self";
  if (o.peerLive) return "peer";
  if (!o.peerReachesMe) return "peer";
  return o.selfId < o.peerId ? "self" : "peer";
}

export interface PeerState {
  /** Hub this app's UI should use ("host:port"). */
  referee: string;
  /** The other app, when it's around and speaks our protocol. */
  peer: Found | null;
  /** A peer serving the Windows update feed (the Mac), whatever its version. */
  updateSource: Found | null;
}

export interface PeerManagerOptions {
  hub: Hub;
  /** Manual address and the last one that worked. */
  preferred: () => (string | null | undefined)[];
  remember: (host: string) => void;
  onChange: (state: PeerState) => void;
  tickMs?: number;
  scanEveryMs?: number;
}

export class PeerManager {
  state: PeerState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private misses = 0;
  private lastScan = 0;
  private pending: Choice | null = null;
  private stopped = false;
  readonly ready: Promise<void>;

  constructor(private o: PeerManagerOptions) {
    this.state = { referee: this.selfHost, peer: null, updateSource: null };
    this.ready = this.tick();
  }

  private get selfHost(): string {
    return `127.0.0.1:${this.o.hub.port}`;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Re-check right away (e.g. after the manual address changed). */
  poke(): void {
    this.lastScan = 0;
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    try {
      await this.update();
    } catch (e) {
      console.warn("peer check failed", e);
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), this.o.tickMs ?? 3000);
  }

  private async update(): Promise<void> {
    const hub = this.o.hub;
    let found: Found | null = null;
    const current = this.state.peer ?? this.state.updateSource;
    // Keep the peer we know while it answers; forget it after two misses.
    if (current) {
      found = await findPeer([current.host], hub.hubId, false);
      if (!found && ++this.misses < 2) return;
    }
    if (found) this.misses = 0;
    else {
      const scan = Date.now() - this.lastScan > (this.o.scanEveryMs ?? 15_000);
      if (scan) this.lastScan = Date.now();
      found = await findPeer(this.o.preferred(), hub.hubId, scan);
      this.misses = 0;
    }
    if (found) this.o.remember(found.host);

    const compatible = found && found.info.protocol === PROTOCOL ? found : null;
    let referee = this.selfHost;
    if (compatible) {
      const reach = await this.peerReaches(compatible.host);
      const choice = electReferee({
        selfId: hub.hubId,
        peerId: compatible.info.nodeId,
        peerReachesMe: reach,
        selfLive: hub.hasLiveGame(),
        peerLive: compatible.info.liveGame,
      });
      // With a peer we already knew, only switch on two agreeing checks in a
      // row, so a blip can't flip the referee. A newly found peer applies now.
      const now: Choice = this.state.referee === this.selfHost ? "self" : "peer";
      const known = this.state.peer?.info.nodeId === compatible.info.nodeId;
      if (known && choice !== now && this.pending !== choice) {
        this.pending = choice;
        referee = this.state.referee;
      } else {
        this.pending = null;
        referee = choice === "peer" ? compatible.host : this.selfHost;
      }
    } else {
      this.pending = null;
    }

    if (referee === this.selfHost) hub.unlink();
    else hub.linkTo(referee);

    const next: PeerState = {
      referee,
      peer: compatible,
      updateSource: found && found.info.winUpdates ? found : null,
    };
    const changed =
      next.referee !== this.state.referee ||
      next.peer?.host !== this.state.peer?.host ||
      next.peer?.info.version !== this.state.peer?.info.version ||
      next.updateSource?.host !== this.state.updateSource?.host ||
      next.updateSource?.info.version !== this.state.updateSource?.info.version;
    this.state = next;
    if (changed) this.o.onChange(next);
  }

  /** Asks the peer whether it can reach our hub. */
  private async peerReaches(peerHost: string): Promise<boolean> {
    const me = `${addressFacing(peerHost)}:${this.o.hub.port}`;
    try {
      const res = await fetch(`http://${peerHost}/reach?addr=${encodeURIComponent(me)}`, { signal: AbortSignal.timeout(2500) });
      const body = (await res.json()) as { ok: boolean; nodeId: string | null };
      return body.ok && body.nodeId === this.o.hub.hubId;
    } catch {
      return false;
    }
  }
}
