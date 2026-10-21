// Standalone hub for development and end-to-end tests:
//   node out/hub/cli.js --port 47800 --data .hub-data --static out/renderer
import { hostname } from "node:os";
import { resolve } from "node:path";
import { HUB_PORT } from "../shared/protocol";
import { startHub } from "./hub";

declare const __APP_VERSION__: string;

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

startHub({
  port: Number(arg("port") ?? HUB_PORT),
  dataDir: resolve(arg("data") ?? ".hub-data"),
  staticDir: arg("static") ? resolve(arg("static")!) : undefined,
  updatesDir: arg("updates") ? resolve(arg("updates")!) : undefined,
  hostName: arg("name") ?? hostname(),
  appVersion: __APP_VERSION__,
  log: (m) => console.log(`[hub] ${m}`),
}).then((hub) => {
  console.log(`[hub] ready on port ${hub.port}`);
  const stop = () => hub.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
});
