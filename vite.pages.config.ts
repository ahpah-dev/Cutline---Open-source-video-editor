import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// GitHub project sites live below /<repository>/, not at the origin root.
const base = process.env.CUTLINE_WEB_BASE || "/Cutline---Open-source-video-editor/";
if (!/^\/(?:[A-Za-z0-9_.-]+\/)*$/.test(base)) throw new Error("Invalid web base path.");

export default defineConfig({
  root: "web",
  base,
  publicDir: "../public",
  plugins: [react(), { name: "cutline-pages", generateBundle() {
    this.emitFile({ type: "asset", fileName: ".nojekyll", source: "" });
  } }],
  build: { outDir: "../dist-pages", emptyOutDir: true, sourcemap: false, target: "chrome120" },
});
