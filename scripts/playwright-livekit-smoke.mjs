import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const sidecar = resolve(root, "apps/desktop/src-tauri/binaries/livekit-server-x86_64-unknown-linux-gnu");
const client = resolve(root, "apps/desktop/src-tauri/resources/livekit-client.umd.js");

async function freeTcpPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

function token(apiKey, secret, room, identity, publish) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: apiKey,
    sub: identity,
    nbf: now - 5,
    exp: now + 600,
    video: { roomJoin: true, room, canPublish: publish, canSubscribe: !publish, canPublishData: false }
  })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

async function waitForPort(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await new Promise((resolveReady) => {
      const socket = connectTcp(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolveReady(true); });
      socket.once("error", () => resolveReady(false));
    });
    if (ready) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("LiveKit smoke server did not start.");
}

const temporary = await mkdtemp(join(tmpdir(), "showit-livekit-smoke-"));
const apiPort = await freeTcpPort();
const rtcTcpPort = await freeTcpPort();
const rtcUdpPort = await freeTcpPort();
const apiKey = `showit${randomBytes(12).toString("hex")}`;
const secret = randomBytes(32).toString("hex");
const roomName = "showit-browser-smoke";
const config = join(temporary, "livekit.yaml");
await writeFile(config, `port: ${apiPort}\nbind_addresses:\n  - "127.0.0.1"\nrtc:\n  udp_port: ${rtcUdpPort}\n  tcp_port: ${rtcTcpPort}\n  use_external_ip: false\n  use_mdns: false\n  stun_servers: []\nkeys:\n  "${apiKey}": "${secret}"\nroom:\n  max_participants: 21\nturn:\n  enabled: false\nlogging:\n  level: error\n`);

const server = spawn(sidecar, ["--config", config], { stdio: ["ignore", "ignore", "pipe"] });
let serverError = "";
server.stderr.on("data", (chunk) => { serverError += chunk.toString(); });
let browser;
try {
  await waitForPort(apiPort);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const publisher = await context.newPage();
  const viewer = await context.newPage();
  await publisher.addScriptTag({ path: client });
  await viewer.addScriptTag({ path: client });
  const url = `ws://127.0.0.1:${apiPort}`;
  await publisher.evaluate(async ({ url, accessToken }) => {
    const room = new window.LivekitClient.Room({ dynacast: true });
    await room.connect(url, accessToken, { autoSubscribe: false });
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d");
    let frame = 0;
    window.__showitAnimation = setInterval(() => {
      context.fillStyle = frame++ % 2 ? "#18b7a0" : "#f0b429";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }, 100);
    const stream = canvas.captureStream(10);
    await room.localParticipant.publishTrack(stream.getVideoTracks()[0], { source: window.LivekitClient.Track.Source.ScreenShare, videoCodec: "vp8" });
    window.__showitRoom = room;
    window.__showitStream = stream;
  }, { url, accessToken: token(apiKey, secret, roomName, "publisher", true) });
  await viewer.evaluate(async ({ url, accessToken }) => {
    const room = new window.LivekitClient.Room({ adaptiveStream: true });
    room.on(window.LivekitClient.RoomEvent.TrackSubscribed, (track) => {
      const video = track.attach();
      video.id = "stream";
      video.muted = true;
      video.autoplay = true;
      document.body.append(video);
      void video.play();
    });
    await room.connect(url, accessToken, { autoSubscribe: true });
    window.__showitRoom = room;
  }, { url, accessToken: token(apiKey, secret, roomName, "viewer", false) });
  await viewer.locator("#stream").waitFor({ state: "attached", timeout: 10_000 });
  await viewer.waitForFunction(() => {
    const video = document.querySelector("#stream");
    return video && video.readyState >= 2 && video.videoWidth > 0;
  }, null, { timeout: 10_000 });
  const dimensions = await viewer.locator("#stream").evaluate((video) => ({ width: video.videoWidth, height: video.videoHeight }));
  assert.deepEqual(dimensions, { width: 320, height: 180 });
  console.log("LiveKit browser publish/subscribe smoke: ok");
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}${serverError ? `\n${serverError}` : ""}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise((resolveExit) => server.once("exit", resolveExit));
  await rm(temporary, { recursive: true, force: true });
}
