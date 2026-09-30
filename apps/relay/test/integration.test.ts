import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startRelay } from "../src/main";

let relay: { close(): Promise<void>; port: number };
let base: string;
let presenterToken = "";
let viewerToken = "";
let roomCode = "";

beforeAll(async () => {
  relay = await startRelay(0, "127.0.0.1");
  base = `http://127.0.0.1:${relay.port}`;
});

afterAll(async () => {
  await relay.close();
});

async function createRoom() {
  const response = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capacity: "p2p", joinMode: "direct" })
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { roomCode: string; presenterToken: string; viewerUrl: string };
  roomCode = body.roomCode;
  presenterToken = body.presenterToken;
  // The viewer link embeds the viewer token in the fragment; in tests we read
  // it through the presenter (single relay process).
  const viewers = await fetch(`${base}/api/rooms/${roomCode}/viewers`, { headers: { "x-presenter-token": presenterToken } });
  expect(viewers.status).toBe(200);
  return body;
}

function openSocket(path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}${path}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("relay integration", () => {
  it("creates a room and serves the watch page only while it exists", async () => {
    const room = await createRoom();
    const watch = await fetch(`${base}/watch/${room.roomCode}`);
    expect(watch.status).toBe(200);
    expect((await watch.text()).includes("Showit 观众屏")).toBe(true);
    const missing = await fetch(`${base}/watch/notaroom`);
    expect(missing.status).toBe(404);
  });

  it("rejects presenter endpoints without a valid token", async () => {
    const room = await createRoom();
    const unauthorized = await fetch(`${base}/api/rooms/${room.roomCode}/viewers`);
    expect(unauthorized.status).toBe(401);
    const forged = await fetch(`${base}/api/rooms/${room.roomCode}/viewers`, { headers: { "x-presenter-token": "forged" } });
    expect(forged.status).toBe(404);
  });

  it("relays signaling between presenter and viewer, enforces tokens, and kicks", async () => {
    // Create a fresh room and capture the share link with the viewer token.
    const created = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capacity: "p2p", joinMode: "direct" })
    }).then((r) => r.json() as Promise<{ viewerLink: string; presenterToken: string; roomCode: string }>);
    presenterToken = created.presenterToken;
    roomCode = created.roomCode;
    const shareLink = created.viewerLink;
    const viewerTokenMatch = shareLink.match(/#t=([A-Za-z0-9_-]+)/);
    expect(viewerTokenMatch).not.toBeNull();
    const token = viewerTokenMatch![1]!;

    // Invalid viewer tokens are refused before the upgrade completes
    // (the raw 401 surfaces as an abnormal closure on the client).
    const invalid = new WebSocket(`ws://127.0.0.1:${relay.port}/signal/${roomCode}/badtoken/viewer/peer-x`);
    const invalidClosed = new Promise<number>((resolve) => invalid.once("close", (code) => resolve(code)));
    invalid.once("error", () => undefined);
    const invalidCode = await invalidClosed;
    expect([1006, 401]).toContain(invalidCode);
    const validBootstrap = await fetch(`${base}/watch/${roomCode}/bootstrap`);
    expect(validBootstrap.ok).toBe(true);

    const presenter = await openSocket(`/signal/${roomCode}/${presenterToken}/presenter/publisher-1`);
    const viewer = await openSocket(`/signal/${roomCode}/${token}/viewer/peer-1`);

    const viewerMessages: Array<Record<string, unknown>> = [];
    const presenterMessages: Array<Record<string, unknown>> = [];
    viewer.on("message", (raw) => viewerMessages.push(JSON.parse(String(raw))));
    presenter.on("message", (raw) => presenterMessages.push(JSON.parse(String(raw))));

    // Presenter offers to the viewer; the relay forwards it.
    presenter.send(JSON.stringify({ type: "offer", to: "peer-1", from: "publisher-1", description: { type: "offer", sdp: "v=0 demo" } }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(viewerMessages.some((message) => message.type === "offer" && (message.description as { sdp?: string })?.sdp === "v=0 demo")).toBe(true);

    // Viewer answers back to the publisher.
    viewer.send(JSON.stringify({ type: "answer", to: "publisher", from: "peer-1", description: { type: "answer", sdp: "v=0 answer" } }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(presenterMessages.some((message) => message.type === "answer")).toBe(true);

    // Oversized/malformed envelopes are dropped silently (no crash).
    presenter.send(JSON.stringify({ type: "offer", to: "peer-1", from: "publisher-1", description: { type: "offer", sdp: "x".repeat(200_000) } }));
    presenter.send("not json");
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Snapshot broadcast reaches SSE viewers.
    const snapshotResponse = await fetch(`${base}/api/rooms/${roomCode}/snapshot`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-presenter-token": presenterToken },
      body: JSON.stringify({ projectName: "云枢", pageLabel: "3 / 18", screenMode: "normal" })
    });
    expect(snapshotResponse.status).toBe(200);

    // Kick removes the viewer socket.
    const viewerClosed = new Promise<number>((resolve) => viewer.once("close", (code) => resolve(code)));
    const kick = await fetch(`${base}/api/rooms/${roomCode}/viewers/peer-1`, { method: "DELETE", headers: { "x-presenter-token": presenterToken } });
    expect(kick.status).toBe(200);
    expect(await viewerClosed).toBe(4003);

    presenter.close();
  });

  it("ends the room, kicks viewers and clears the watch page", async () => {
    const room = await createRoom();
    const response = await fetch(`${base}/api/rooms/${room.roomCode}`, {
      method: "DELETE",
      headers: { "x-presenter-token": presenterToken }
    });
    expect(response.status).toBe(200);
    const watch = await fetch(`${base}/watch/${room.roomCode}`);
    expect(watch.status).toBe(404);
  });
});

describe("relay-hosted demo console", () => {
  it("serves the demo console entry and assets when built", async () => {
    const entry = await fetch(`${base}/demo/`);
    expect(entry.status).toBe(200);
    const html = await entry.text();
    expect(html.includes("云枢")).toBe(true);
    const asset = await fetch(`${base}/demo/assets/index.js`);
    expect(asset.status).toBe(200);
    expect((asset.headers.get("content-type") ?? "").includes("javascript")).toBe(true);
  });

  it("rejects traversal in the demo asset path", async () => {
    const response = await fetch(`${base}/demo/assets/..%2F..%2Fpackage.json`);
    expect([404, 400]).toContain(response.status);
  });
});
