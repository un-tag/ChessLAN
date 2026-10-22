import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchHello, startHub } from "../hub/hub";
import { addressFacing, findPeer, splitHost } from "./discovery";

describe("discovery", () => {
  it("parses host addresses", () => {
    expect(splitHost("192.168.1.20")).toEqual(["192.168.1.20", 47800]);
    expect(splitHost(" mac.local:5000 ")).toEqual(["mac.local", 5000]);
  });

  it("uses loopback to face a loopback peer", () => {
    expect(addressFacing("127.0.0.1:47801")).toBe("127.0.0.1");
  });

  it("finds another app at a preferred address, skipping itself and non-hubs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chesslan-disc-"));
    const dir2 = mkdtempSync(join(tmpdir(), "chesslan-disc-"));
    const me = await startHub({ dataDir: dir, appVersion: "t", port: 0, host: "127.0.0.1" });
    const other = await startHub({ dataDir: dir2, appVersion: "t", port: 0, host: "127.0.0.1" });
    try {
      expect(await fetchHello("127.0.0.1:1", 300)).toBeNull();
      const found = await findPeer(["127.0.0.1:1", `127.0.0.1:${me.port}`, `127.0.0.1:${other.port}`], me.hubId, false);
      expect(found).toMatchObject({ host: `127.0.0.1:${other.port}`, info: { nodeId: other.hubId } });
      expect(await findPeer([`127.0.0.1:${me.port}`], me.hubId, false)).toBeNull();
    } finally {
      await me.close();
      await other.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
