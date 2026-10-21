// Bundles the Electron main process, the preload script and the standalone
// hub CLI with esbuild. The renderer is built separately by Vite.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const dev = process.argv.includes("--dev");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: dev ? "inline" : false,
  external: ["electron", "electron-updater"],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __DEV__: JSON.stringify(dev),
  },
  logLevel: "warning",
};

await Promise.all([
  build({ ...common, entryPoints: ["src/main/main.ts"], outfile: "out/main/main.js" }),
  build({ ...common, entryPoints: ["src/preload/preload.ts"], outfile: "out/preload/preload.js" }),
  build({ ...common, entryPoints: ["src/hub/cli.ts"], outfile: "out/hub/cli.js" }),
]);
