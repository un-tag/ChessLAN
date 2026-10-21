import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds the renderer (UI) into out/renderer. Main, preload and the
// standalone hub are bundled by scripts/build.mjs with esbuild.
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../out/renderer",
    emptyOutDir: true,
    target: "chrome130",
  },
  worker: { format: "es" },
  server: { port: 5173, strictPort: true },
});
