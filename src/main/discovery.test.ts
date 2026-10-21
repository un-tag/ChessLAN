import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHub } from "../hub/hub";
import { discoverHub, probe, splitHost } from "./discovery";

describe("discovery", () => {
  it("parses host addresses", () => {
    expect(splitHost("192.168.1.20")).toEqual(["192.168.1.20", 47800]);
    expect(splitHost(" mac.local:5000 ")).toEqual(["mac.local", 5000]);
  });

  it("finds a hub at a preferred address and ignores non-hubs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chesslan-disc-"));
    const hub = await startHub({ dataDir: dir, appVersion: "t", port: 0, host: "127.0.0.1" });
    try {
      expect(await probe(`127.0.0.1:${hub.port}`)).toMatchObject({ app: "chesslan", hubId: hub.hubId });
      expect(await probe("127.0.0.1:1", 300)).toBeNull();
      expect(await discoverHub(["127.0.0.1:1", `127.0.0.1:${hub.port}`])).toBe(`127.0.0.1:${hub.port}`);
    } finally {
      await hub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
