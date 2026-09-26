import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import type { ProxyOptions } from "vite";

const readonlyMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const readonlyPaths = ["/console", "/api", "/presentation-health"];
const authenticationWritePaths = new Set(["/api/lc/v1/auth/login", "/api/lc/v1/session/logout"]);
const readonlyProxy = Object.fromEntries(readonlyPaths.map((path): [string, ProxyOptions] => [path, {
  target: "http://localhost:3001",
  changeOrigin: true,
  configure(proxy) {
    proxy.on("proxyRes", (response) => {
      delete response.headers["content-security-policy"];
      delete response.headers["content-security-policy-report-only"];
      delete response.headers["x-frame-options"];
    });
  }
}]));

export default defineConfig({
  plugins: [
    react(),
    {
      name: "showit-development-readonly-guard",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const pathname = new URL(request.url ?? "/", "http://showit.local").pathname;
          const authenticationWrite = request.method === "POST" && authenticationWritePaths.has(pathname);
          if (readonlyPaths.some((path) => pathname.startsWith(path)) && !readonlyMethods.has(request.method ?? "GET") && !authenticationWrite) {
            response.statusCode = 405;
            response.setHeader("allow", "GET, HEAD, OPTIONS");
            response.end("Showit development proxy is read-only.");
            return;
          }
          next();
        });
      }
    }
  ],
  clearScreen: false,
  server: {
    port: 4173,
    strictPort: true,
    proxy: readonlyProxy
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: true
  }
});
