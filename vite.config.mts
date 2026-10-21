import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Builds the renderer (UI) into out/renderer. Main, preload and the
// standalone hub are bundled by scripts/build.mjs with esbuild.
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: "../../out/renderer",
    emptyOutDir: true,
    target: "chrome130",
  },
  worker: { format: "es" },
  server: { port: 5173, strictPort: true },
});
