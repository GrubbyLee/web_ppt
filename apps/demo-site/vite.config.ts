import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  // Served by the relay under /demo/ — asset URLs must carry that prefix.
  base: "/demo/",
  plugins: [react()],
  resolve: {
    alias: {
      "@showit/demo": resolve(here, "../../apps/extension/lib/demo"),
      "@showit/contracts": resolve(here, "../../packages/contracts/src/index.ts"),
      "@showit/messaging": resolve(here, "../../apps/extension/messaging/protocol.ts"),
    },
  },
  build: {
    outDir: resolve(here, "../../apps/relay/public/demo"),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
