import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHub, type Hub } from "../hub/hub";
import { electReferee, PeerManager, type PeerState } from "./peers";

describe("electReferee", () => {
  const base = { selfId: "a", peerId: "b", peerReachesMe: true, selfLive: false, peerLive: false };
  it("picks the smaller id when both can reach each other", () => {
    expect(electReferee(base)).toBe("self");
    expect(electReferee({ ...base, selfId: "c" })).toBe("peer");
  });
  it("picks the reachable side when only one direction works", () => {
    expect(electReferee({ ...base, peerReachesMe: false })).toBe("peer");
  });
  it("never moves a live game", () => {
    expect(electReferee({ ...base, selfId: "z", selfLive: true })).toBe("self");
    expect(electReferee({ ...base, peerLive: true })).toBe("peer");
  });
});

describe("PeerManager", () => {
  const hubs: Hub[] = [];
  const managers: PeerManager[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const m of managers.splice(0)) m.stop();
    for (const h of hubs.splice(0)) await h.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function node() {
    const dir = mkdtempSync(join(tmpdir(), "chesslan-pm-"));
    dirs.push(dir);
    const hub = await startHub({ dataDir: dir, appVersion: "t", port: 0, host: "127.0.0.1" });
    hubs.push(hub);
    return hub;
  }

  function manage(hub: Hub, other: () => Hub | undefined) {
    const states: PeerState[] = [];
    const m = new PeerManager({
      hub,
      preferred: () => [other() ? `127.0.0.1:${other()!.port}` : null],
      remember: () => {},
      onChange: (s) => states.push(s),
      tickMs: 100,
      scanEveryMs: 1e9, // no subnet scans in tests
    });
    managers.push(m);
    return { m, states };
  }

  const until = async (cond: () => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it("both sides agree on one referee, and the follower links to it", async () => {
    const a = await node();
    const b = await node();
    const ma = manage(a, () => b);
    const mb = manage(b, () => a);
    const [lo, hi] = a.hubId < b.hubId ? [a, b] : [b, a];
    const [mlo, mhi] = a.hubId < b.hubId ? [ma, mb] : [mb, ma];
    await until(() => mhi.m.state.referee === `127.0.0.1:${lo.port}` && mlo.m.state.referee === `127.0.0.1:${lo.port}`);
    await until(() => hi.linkedTo() === `127.0.0.1:${lo.port}`);
    expect(lo.linkedTo()).toBeNull();
    expect(mlo.m.state.peer?.info.nodeId).toBe(hi.hubId);
  });

  it("falls back to its own hub when the referee disappears", async () => {
    const a = await node();
    const b = await node();
    let aAlive = true;
    const [lo, hi] = a.hubId < b.hubId ? [a, b] : [b, a];
    const mhi = manage(hi, () => (aAlive ? lo : undefined));
    manage(lo, () => hi);
    await until(() => mhi.m.state.referee === `127.0.0.1:${lo.port}`);
    aAlive = false;
    await lo.close();
    hubs.splice(hubs.indexOf(lo), 1);
    await until(() => mhi.m.state.referee === `127.0.0.1:${hi.port}`);
    expect(mhi.m.state.peer).toBeNull();
  });
});
