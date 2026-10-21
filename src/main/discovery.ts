// Finds the host on the LAN using outbound TCP only, so the Windows
// firewall never asks for permission: try the remembered/manual address,
// then probe port 47800 across each local IPv4 subnet and confirm with
// GET /hello.
import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { HUB_PORT } from "../shared/protocol";

export interface HelloInfo {
  app: string;
  protocol: number;
  version: string;
  hubId: string;
  hostName: string;
}

export function probe(host: string, timeoutMs = 700): Promise<HelloInfo | null> {
  return new Promise((resolve) => {
    const [hostname, port] = splitHost(host);
    const req = request({ host: hostname, port, path: "/hello", method: "GET", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const info = JSON.parse(body) as HelloInfo;
          resolve(info.app === "chesslan" ? info : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
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

/** Probes many hosts with bounded concurrency; resolves on the first hub found. */
async function scan(hosts: string[], concurrency = 96, timeoutMs = 450): Promise<string | null> {
  let index = 0;
  let found: string | null = null;
  const worker = async () => {
    while (!found && index < hosts.length) {
      const host = `${hosts[index++]}:${HUB_PORT}`;
      const info = await probe(host, timeoutMs);
      // A hub on another version still counts: connecting lets this app update.
      if (info && !found) found = host;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found;
}

export async function discoverHub(preferred: (string | null)[]): Promise<string | null> {
  for (const host of preferred) {
    if (!host) continue;
    const withPort = splitHost(host).join(":");
    if (await probe(withPort)) return withPort;
  }
  return scan(subnetCandidates());
}
