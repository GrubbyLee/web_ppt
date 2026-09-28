import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["lib/**/*.test.ts", "session/**/*.test.ts"],
    restoreMocks: true
  },
  resolve: {
    alias: {
      "@showit/contracts": fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url)),
      "@/lib": fileURLToPath(new URL("./lib", import.meta.url)),
      "@/session": fileURLToPath(new URL("./session", import.meta.url)),
      "@/messaging": fileURLToPath(new URL("./messaging", import.meta.url)),
      "@/components": fileURLToPath(new URL("./components", import.meta.url))
    }
  }
});
