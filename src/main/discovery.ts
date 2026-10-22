// Finding other ChessLAN apps on the LAN: try remembered/manual addresses,
// then probe port 47800 across each local IPv4 subnet and confirm with
// GET /hello. Everything here is outbound TCP.
import { networkInterfaces } from "node:os";
import { fetchHello } from "../hub/hub";
import { HUB_PORT, type HelloInfo } from "../shared/protocol";

export interface Found {
  host: string; // "ip:port"
  info: HelloInfo;
}

/** "192.168.1.20" or "mac.local:47800" → [host, port]. */
export function splitHost(host: string): [string, number] {
  const m = /^(.+?)(?::(\d+))?$/.exec(host.trim());
  return m ? [m[1], m[2] ? Number(m[2]) : HUB_PORT] : [host, HUB_PORT];
}

const ipToInt = (ip: string): number => ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const intToIp = (n: number): string => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");

/** All candidate host addresses on our directly attached IPv4 networks. */
export function subnetCandidates(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      const self = ipToInt(ni.address);
      let mask = ipToInt(ni.netmask);
      // Bound the scan: anything bigger than /22 is scanned as the /24 around us.
      if (mask < ipToInt("255.255.252.0")) mask = ipToInt("255.255.255.0");
      const net = (self & mask) >>> 0;
      const size = (~mask >>> 0) + 1;
      // Nearest addresses first: routers hand out neighbouring IPs.
      const hosts: number[] = [];
      for (let i = 1; i < size - 1; i++) hosts.push((net + i) >>> 0);
      hosts.sort((a, b) => Math.abs(a - self) - Math.abs(b - self));
      for (const h of hosts) if (h !== self) out.add(intToIp(h));
    }
  }
  return [...out];
}

export function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((ni) => ni && ni.family === "IPv4" && !ni.internal)
    .map((ni) => ni!.address);
}

/** Our address as the given peer would reach it: the local IP sharing the most leading octets. */
export function addressFacing(peerHost: string): string {
  const [ip] = splitHost(peerHost);
  if (ip === "127.0.0.1" || ip === "localhost") return "127.0.0.1";
  const target = ip.split(".");
  let best = localAddresses()[0] ?? "127.0.0.1";
  let bestScore = -1;
  for (const a of localAddresses()) {
    const parts = a.split(".");
    let score = 0;
    while (score < 4 && parts[score] === target[score]) score++;
    if (score > bestScore) [best, bestScore] = [a, score];
  }
  return best;
}

/** Probes many hosts with bounded concurrency; resolves on the first other ChessLAN app found. */
async function scan(hosts: string[], selfId: string, concurrency = 96, timeoutMs = 450): Promise<Found | null> {
  let index = 0;
  let found: Found | null = null;
  const worker = async () => {
    while (!found && index < hosts.length) {
      const host = hosts[index++];
      const info = await fetchHello(host, timeoutMs);
      if (info && info.nodeId !== selfId && !found) found = { host, info };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found;
}

/** Looks for another ChessLAN app: preferred addresses first, then (optionally) the subnet. */
export async function findPeer(preferred: (string | null | undefined)[], selfId: string, scanSubnet: boolean): Promise<Found | null> {
  for (const raw of preferred) {
    if (!raw) continue;
    const host = splitHost(raw).join(":");
    const info = await fetchHello(host, 700);
    if (info && info.nodeId !== selfId) return { host, info };
  }
  if (!scanSubnet) return null;
  return scan(subnetCandidates().map((ip) => `${ip}:${HUB_PORT}`), selfId);
}
