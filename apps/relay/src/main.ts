import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { readFileSync, existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayError, RoomStore, type Room } from "./rooms";
import { sanitizeSignalMessage, type SignalEnvelope } from "./signal";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PORT = Number(process.env.SHOWIT_RELAY_PORT ?? 8787);
const HOST = process.env.SHOWIT_RELAY_HOST ?? "0.0.0.0";
const BASE_URL = process.env.SHOWIT_RELAY_BASE_URL ?? `http://127.0.0.1:${PORT}`;

const store = new RoomStore();

// ---- HTTP ---------------------------------------------------------------------

type RouteHandler = (request: IncomingMessage, response: ServerResponse, match: RegExpMatchArray) => Promise<void> | void;

const routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }> = [];

function route(method: string, pattern: string, handler: RouteHandler): void {
  routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-presenter-token",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS"
  });
  response.end(payload);
}

async function readJsonBody(request: IncomingMessage, limitBytes = 64 * 1_024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new RelayError("body-too-large", "请求体超出限制。", 413);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new RelayError("invalid-json", "请求体不是有效 JSON。", 400);
  }
}

function requirePresenterRoom(request: IncomingMessage): Room {
  const token = request.headers["x-presenter-token"];
  if (typeof token !== "string" || token.length === 0) throw new RelayError("token-required", "缺少演讲者令牌。", 401);
  const room = store.roomByPresenterToken(token);
  if (!room) throw new RelayError("room-not-found", "房间不存在或已结束。", 404);
  return room;
}

// Presenter: create a room.
route("POST", "/api/rooms", async (request, response) => {
  const body = await readJsonBody(request);
  const capacity = body.capacity === "sfu" ? "sfu" : "p2p";
  const joinMode = body.joinMode === "approval" ? "approval" : "direct";
  const summary = store.createRoom({ baseUrl: BASE_URL, capacity, joinMode });
  sendJson(response, 201, summary);
});

// Presenter: end the room.
route("DELETE", "/api/rooms/([a-z2-9]+)", async (request, response, match) => {
  const room = requirePresenterRoom(request);
  if (room.roomCode !== match[1]) throw new RelayError("room-mismatch", "令牌与房间不匹配。", 403);
  store.endRoom(room);
  signalSockets.evictRoom(room.roomCode);
  sendJson(response, 200, { ok: true });
});

// Presenter: list viewers.
route("GET", "/api/rooms/([a-z2-9]+)/viewers", async (request, response, match) => {
  const room = requirePresenterRoom(request);
  if (room.roomCode !== match[1]) throw new RelayError("room-mismatch", "令牌与房间不匹配。", 403);
  sendJson(response, 200, { viewers: store.viewerList(room) });
});

// Presenter: approve/reject a pending viewer.
route("POST", "/api/rooms/([a-z2-9]+)/viewers/([a-zA-Z0-9-]+)", async (request, response, match) => {
  const room = requirePresenterRoom(request);
  if (room.roomCode !== match[1]) throw new RelayError("room-mismatch", "令牌与房间不匹配。", 403);
  const body = await readJsonBody(request);
  const ok = store.decideViewer(room, match[2]!, body.approve === true);
  if (!ok) throw new RelayError("viewer-not-pending", "观众不存在或不在等待批准状态。", 404);
  sendJson(response, 200, { ok: true });
});

// Presenter: kick a viewer.
route("DELETE", "/api/rooms/([a-z2-9]+)/viewers/([a-zA-Z0-9-]+)", async (request, response, match) => {
  const room = requirePresenterRoom(request);
  if (room.roomCode !== match[1]) throw new RelayError("room-mismatch", "令牌与房间不匹配。", 403);
  if (!store.kickViewer(room, match[2]!)) throw new RelayError("viewer-not-found", "观众不存在。", 404);
  signalSockets.kickViewer(room.roomCode, match[2]!);
  sendJson(response, 200, { ok: true });
});

// Presenter: publish the session snapshot (audience state: page/brand/masks).
route("PUT", "/api/rooms/([a-z2-9]+)/snapshot", async (request, response, match) => {
  const room = requirePresenterRoom(request);
  if (room.roomCode !== match[1]) throw new RelayError("room-mismatch", "令牌与房间不匹配。", 403);
  const body = await readJsonBody(request, 512 * 1_024);
  room.snapshot = body;
  store.touch(room);
  sseChannels.publishSnapshot(room.roomCode, body);
  sendJson(response, 200, { ok: true });
});

// Watch page: static HTML (single file, no build).
route("GET", "/watch/([a-z2-9]+)", (_request, response, match) => {
  const roomCode = match[1]!;
  if (!store.roomByCode(roomCode)) {
    sendJson(response, 404, { error: "房间不存在或已结束。" });
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src blob:; connect-src 'self' ws: wss:; img-src data:"
  });
  response.end(watchPageHtml(roomCode));
});

// Watch page: bootstrap payload (viewer token comes via the URL fragment —
// never sent to the server — so bootstrap only carries join mode/capacity).
route("GET", "/watch/([a-z2-9]+)/bootstrap", (_request, response, match) => {
  const room = store.roomByCode(match[1]!);
  if (!room) throw new RelayError("room-not-found", "房间不存在或已结束。", 404);
  sendJson(response, 200, { joinMode: room.joinMode, capacity: room.capacity, viewerCount: room.viewers.size });
});

route("GET", "/health", (_request, response) => {
  sendJson(response, 200, { ok: true, rooms: 0 });
});

const server = createServer(async (request, response) => {
  const url = (request.url ?? "/").split("?")[0]!;
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }
  try {
    for (const entry of routes) {
      if (entry.method !== request.method) continue;
      const match = url.match(entry.pattern);
      if (match) {
        await entry.handler(request, response, match);
        return;
      }
    }
    sendJson(response, 404, { error: "未找到资源。" });
  } catch (error) {
    if (error instanceof RelayError) {
      sendJson(response, error.status, { error: error.message, code: error.code });
      return;
    }
    console.error("[relay] unhandled:", error);
    sendJson(response, 500, { error: "中继内部错误。" });
  }
});

// ---- SSE (audience snapshot channel) -------------------------------------------

type SseClient = { response: ServerResponse; roomCode: string };

class SseChannels {
  private clients = new Set<SseClient>();

  add(roomCode: string, response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive"
    });
    // A browser tab closing destroys the socket; pending or later writes
    // then throw synchronously. Guard every write and drop dead clients.
    response.on("error", () => this.remove(response));
    response.write("retry: 3000\n\n");
    const client: SseClient = { response, roomCode };
    this.clients.add(client);
    response.on("close", () => this.clients.delete(client));
  }

  private remove(response: ServerResponse): void {
    for (const client of this.clients) {
      if (client.response === response) this.clients.delete(client);
    }
  }

  private safeWrite(client: SseClient, payload: string): void {
    try {
      if (client.response.destroyed || client.response.writableEnded) {
        this.clients.delete(client);
        return;
      }
      client.response.write(payload);
    } catch {
      this.clients.delete(client);
    }
  }

  publishSnapshot(roomCode: string, snapshot: unknown): void {
    const payload = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of this.clients) {
      if (client.roomCode !== roomCode) continue;
      this.safeWrite(client, payload);
    }
  }

  broadcast(roomCode: string, event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      if (client.roomCode !== roomCode) continue;
      this.safeWrite(client, payload);
    }
  }
}

const sseChannels = new SseChannels();

// ---- WebSocket signaling ---------------------------------------------------------

type SignalClient = {
  socket: WebSocket;
  roomCode: string;
  role: "presenter" | "viewer";
  peerId: string;
  viewerId: string | null;
  alive: boolean;
};

class SignalSockets {
  private clients = new Set<SignalClient>();

  add(client: SignalClient): void {
    this.clients.add(client);
    client.socket.on("pong", () => { client.alive = true; });
  }

  remove(client: SignalClient): void {
    this.clients.delete(client);
  }

  private roomPeers(roomCode: string): SignalClient[] {
    return [...this.clients].filter((client) => client.roomCode === roomCode);
  }

  /** Deliver a message to one peer (or the presenter when addressed as such).
   *  `to === "*"` fans out to every viewer in the room. */
  private sendTo(client: SignalClient, payload: string): void {
    try {
      if (client.socket.readyState === client.socket.OPEN) client.socket.send(payload);
    } catch {
      this.clients.delete(client);
    }
  }

  deliver(roomCode: string, to: string, message: SignalEnvelope): void {
    const payload = JSON.stringify(message);
    for (const client of this.roomPeers(roomCode)) {
      if (to === "*") {
        if (client.role === "viewer") this.sendTo(client, payload);
        continue;
      }
      if (client.peerId === to || (to === "publisher" && client.role === "presenter")) {
        this.sendTo(client, payload);
        return;
      }
    }
  }

  notifyPresenter(roomCode: string, message: SignalEnvelope): void {
    const payload = JSON.stringify(message);
    for (const client of this.roomPeers(roomCode)) {
      if (client.role === "presenter") this.sendTo(client, payload);
    }
  }

  /** Notify the presenter that a viewer joined / left (audience bookkeeping). */
  notifyViewerState(roomCode: string, viewer: { viewerId: string; displayName: string; status: string }): void {
    sseChannels.broadcast(roomCode, "viewer-state", viewer);
    const payload = JSON.stringify({ type: "leave", from: "viewer-state", displayName: viewer.displayName });
    for (const client of this.roomPeers(roomCode)) {
      if (client.role === "presenter") this.sendTo(client, payload);
    }
  }

  broadcastLeave(roomCode: string, peerId: string): void {
    const payload = JSON.stringify({ type: "leave", from: peerId });
    for (const client of this.roomPeers(roomCode)) {
      this.sendTo(client, payload);
    }
  }

  kickViewer(roomCode: string, viewerId: string): void {
    for (const client of this.roomPeers(roomCode)) {
      if (client.viewerId === viewerId) {
        client.socket.close(4003, "kicked");
        this.clients.delete(client);
      }
    }
  }

  evictRoom(roomCode: string): void {
    for (const client of this.roomPeers(roomCode)) {
      client.socket.close(4004, "room-ended");
      this.clients.delete(client);
    }
    sseChannels.broadcast(roomCode, "room-ended", { roomCode });
  }

  sweepDead(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.socket.terminate();
        this.clients.delete(client);
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }

  roomCount(roomCode: string): number {
    return this.roomPeers(roomCode).filter((client) => client.role === "viewer").length;
  }

  closeAll(): void {
    for (const client of this.clients) {
      client.socket.terminate();
    }
    this.clients.clear();
  }
}

const signalSockets = new SignalSockets();

const wss = new WebSocketServer({ noServer: true, maxPayload: 160 * 1_024 });

server.on("upgrade", (request, socket, head) => {
  const url = (request.url ?? "").split("?")[0]!;
  const match = url.match(/^\/signal\/([a-z2-9]+)\/([A-Za-z0-9_-]+)\/(presenter|viewer)\/([A-Za-z0-9-]+)$/);
  const sseMatch = url.match(/^\/events\/([a-z2-9]+)\/([A-Za-z0-9_-]+)$/);
  if (sseMatch) {
    const room = store.verifyViewerToken(sseMatch[1]!, sseMatch[2]!);
    if (!room) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, () => undefined);
    // SSE runs over raw HTTP; handle it via the route table instead.
    socket.write("HTTP/1.1 426 Upgrade Required\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!match) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  const roomCode = match[1]!;
  const token = match[2]!;
  const role = match[3] as "presenter" | "viewer";
  const peerId = match[4]!;
  const room = role === "presenter"
    ? (store.roomByPresenterToken(token)?.roomCode === roomCode ? store.roomByCode(roomCode) : null)
    : store.verifyViewerToken(roomCode, token);
  if (!room || room.roomCode !== roomCode) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    const client: SignalClient = { socket: ws, roomCode, role, peerId, viewerId: null, alive: true };
    if (role === "viewer") {
      const displayName = `观众 ${peerId.slice(0, 6)}`;
      const registered = store.registerViewer(room, peerId, displayName, peerId);
      if ("error" in registered) {
        ws.close(4001, registered.error);
        return;
      }
      client.viewerId = registered.viewerId;
      if (registered.status === "pending") {
        ws.send(JSON.stringify({ type: "leave", from: "approval", displayName: "等待演讲者批准" }));
        // Hold until approved; the presenter approves via REST, then the
        // viewer reconnects (simplest correct flow).
        ws.close(4002, "等待批准");
        return;
      }
    }
    signalSockets.add(client);
    store.markViewerConnected(room, peerId);
    signalSockets.notifyViewerState(roomCode, { viewerId: client.viewerId ?? peerId, displayName: `观众 ${peerId.slice(0, 6)}`, status: "connected" });
    if (role === "presenter") {
      ws.send(JSON.stringify({ type: "join", from: "relay", displayName: "已连接为中继发布端" }));
    }

    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      const envelope = sanitizeSignalMessage(parsed);
      if (!envelope) return;
      store.touch(room);
      if (envelope.type === "leave") {
        signalSockets.broadcastLeave(roomCode, envelope.from);
        return;
      }
      if (envelope.to === undefined) {
        // Fan out to every viewer (e.g. publisher preference defaults).
        signalSockets.deliver(roomCode, "*", envelope);
        return;
      }
      signalSockets.deliver(roomCode, envelope.to, envelope);
    });

    ws.on("close", () => {
      signalSockets.remove(client);
      if (client.role === "viewer") {
        store.removeViewerByPeerId(room, peerId);
        signalSockets.broadcastLeave(roomCode, peerId);
        sseChannels.broadcast(roomCode, "viewer-state", { viewerId: client.viewerId ?? peerId, displayName: "", status: "disconnected" });
      }
    });
  });
});

// SSE endpoint as a plain HTTP route (registered after the server exists).
route("GET", "/events/([a-z2-9]+)/([A-Za-z0-9_-]+)", (request, response, match) => {
  const room = store.verifyViewerToken(match[1]!, match[2]!);
  if (!room) throw new RelayError("room-not-found", "房间不存在或已结束。", 404);
  // The channel helper guards every write against destroyed sockets.
  sseChannels.add(match[1]!, response);
  if (room.snapshot) {
    sseChannels.publishSnapshot(match[1]!, room.snapshot);
  }
});

// ---- idle sweep ------------------------------------------------------------------

setInterval(() => {
  store.evictIdleRooms(new Date());
  signalSockets.sweepDead();
}, 60 * 1_000).unref();

// ---- watch page ------------------------------------------------------------------

function watchPageHtml(roomCode: string): string {
  const file = resolve(__dirname, "../public/watch.html");
  if (existsSync(file)) {
    return readFileSync(file, "utf8").replace("__ROOM_CODE__", roomCode);
  }
  return `<!doctype html><html lang="zh-CN"><body style="font-family:system-ui;background:#0d1015;color:#f5f8fb;display:flex;align-items:center;justify-content:center;height:100vh"><p>观众页资源缺失，请检查中继部署。</p></body></html>`;
}

export function startRelay(port = PORT, host = HOST): Promise<{ close(): Promise<void>; port: number }> {
  return new Promise((resolveStart) => {
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolveStart({
        port: actualPort,
        close: () => new Promise<void>((resolveClose) => {
          signalSockets.closeAll();
          wss.close();
          server.close(() => resolveClose());
        })
      });
    });
  });
}

// Direct-run entry (node src/main.ts).
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  startRelay().then(({ port }) => {
    console.log(`Showit audience relay listening on http://127.0.0.1:${port} (base ${BASE_URL})`);
  });
}
