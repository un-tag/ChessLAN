// `npm run dev`: waits for the Vite dev server, then starts Electron on it.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const url = "http://localhost:5173";
const electron = createRequire(import.meta.url)("electron");

for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(url)).ok) break;
  } catch {
    // Not up yet.
  }
  await new Promise((r) => setTimeout(r, 200));
}

const args = ["."];
if (process.getuid?.() === 0) args.push("--no-sandbox");
const child = spawn(electron, args, { stdio: "inherit", env: { ...process.env, VITE_DEV_SERVER_URL: url } });
child.on("exit", (code) => process.exit(code ?? 0));
