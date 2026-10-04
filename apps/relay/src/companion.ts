import { createServer } from "node:http";
import { startRelay } from "./main";

const COMPANION_HOST = process.env.SHOWIT_RELAY_COMPANION_HOST ?? "127.0.0.1";
const COMPANION_PORT = Number(process.env.SHOWIT_RELAY_COMPANION_PORT ?? 8786);
const MAX_COMPANION_PORT_TRIES = 10;

const relay = await startRelay();

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS"
  });
  response.end(JSON.stringify(body));
}

const server = createServer((request, response) => {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { ok: true, service: "showit-relay-companion", relayBaseUrl: relay.baseUrl, relayPort: relay.port });
    return;
  }
  if (request.method === "GET" && request.url === "/api/relay") {
    sendJson(response, 200, { ok: true, relayBaseUrl: relay.baseUrl, relayPort: relay.port });
    return;
  }
  sendJson(response, 404, { error: "未找到资源。" });
});

function listenCompanion(port: number, attempts = 0): void {
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && attempts < MAX_COMPANION_PORT_TRIES) {
      listenCompanion(port + 1, attempts + 1);
      return;
    }
    throw error;
  });
  server.listen(port, COMPANION_HOST, () => {
    console.log(`Showit Relay Companion listening on http://${COMPANION_HOST}:${port}`);
    console.log(`Relay available at ${relay.baseUrl}`);
  });
}

listenCompanion(COMPANION_PORT);

function shutdown(): void {
  server.close();
  void relay.close().finally(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
