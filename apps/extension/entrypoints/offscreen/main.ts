import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { createAudienceCompositor, sanitizeAudienceMasks, type CompositorState } from "@/lib/compositor";
import type { BgMessage, UiMessage } from "@/messaging/protocol";
import { PORT_PREFIX } from "@/messaging/protocol";

let captureStream: MediaStream | null = null;
let audienceStream: MediaStream | null = null;
let compositor: { stream: MediaStream; stop(): void } | null = null;
let latest: CompositorState & { captureUnsafe: boolean } = { screenMode: "privacy", offlineFallbackActive: true, privacyMasks: [], captureUnsafe: true };
const peers = new Map<string, RTCPeerConnection>();
/** Remote (relay) viewers: peerId → connection. Kept separate from loopback. */
const relayPeers = new Map<string, RTCPeerConnection>();
let port: Browser.runtime.Port | null = null;

function post(message: UiMessage): void {
  try {
    port?.postMessage(message);
  } catch {
    // The background will rebuild the pipeline on the next viewer join.
  }
}

function readState(): CompositorState {
  return {
    screenMode: latest.screenMode,
    offlineFallbackActive: latest.offlineFallbackActive || latest.captureUnsafe,
    privacyMasks: latest.privacyMasks,
    maskTitle: latest.maskTitle
  };
}

function closePeer(viewerId: string): void {
  const peer = peers.get(viewerId);
  if (!peer) return;
  peers.delete(viewerId);
  try {
    peer.close();
  } catch {
    // Already closed.
  }
}

function stopCapture(): void {
  for (const viewerId of [...peers.keys()]) closePeer(viewerId);
  compositor?.stop();
  compositor = null;
  audienceStream = null;
  captureStream?.getTracks().forEach((track) => track.stop());
  captureStream = null;
  post({ type: "capture-state", active: false });
}

async function startCapture(streamId: string): Promise<void> {
  if (compositor) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        // Chrome-specific constraint: consume the tab stream signed by the
        // background service worker.
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      } as MediaTrackConstraints
    });
    stopCapture();
    captureStream = stream;
    compositor = createAudienceCompositor(stream, readState);
    audienceStream = compositor.stream;
    post({ type: "capture-state", active: true });
    for (const viewerId of pendingViewers) void addViewer(viewerId);
    pendingViewers.clear();
    // Relay viewers reconnect on their next answer; nothing to do here.
    stream.getVideoTracks().forEach((track) => track.addEventListener("ended", () => {
      if (captureStream === stream) stopCapture();
    }, { once: true }));
  } catch (error) {
    stopCapture();
    post({ type: "capture-state", active: false, error: error instanceof Error ? error.message : "标签捕获被拒绝或不可用。" });
  }
}

const pendingViewers = new Set<string>();

async function addViewer(viewerId: string): Promise<void> {
  if (peers.has(viewerId)) return;
  if (!audienceStream) {
    pendingViewers.add(viewerId);
    return;
  }
  const peer = new RTCPeerConnection({ iceServers: [] });
  peers.set(viewerId, peer);
  audienceStream.getTracks().forEach((track) => peer.addTrack(track, audienceStream!));
  peer.onicecandidate = (event) => {
    if (event.candidate) post({ type: "rtc-signal", to: viewerId, from: "publisher", data: { type: "candidate", candidate: event.candidate } });
  };
  peer.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(peer.connectionState)) closePeer(viewerId);
  };
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  post({ type: "rtc-signal", to: viewerId, from: "publisher", data: { type: "offer", sdp: peer.localDescription } });
}

function handleSignal(from: string, data: { type?: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }): void {
  const peer = peers.get(from);
  if (!peer || !data || typeof data.type !== "string") return;
  if (data.type === "answer" && data.sdp) void peer.setRemoteDescription(data.sdp).catch(() => undefined);
  if (data.type === "candidate" && data.candidate) void peer.addIceCandidate(data.candidate).catch(() => undefined);
}

// ---- relay (LAN/WAN) publisher ------------------------------------------------

function postUi(message: UiMessage): void {
  try {
    port?.postMessage(message);
  } catch {
    // Background reconnects.
  }
}

function closeRelayPeer(peerId: string): void {
  const peer = relayPeers.get(peerId);
  if (!peer) return;
  relayPeers.delete(peerId);
  try { peer.close(); } catch { /* already closed */ }
}

function closeAllRelayPeers(): void {
  for (const peerId of [...relayPeers.keys()]) closeRelayPeer(peerId);
}

async function addRelayPeer(peerId: string): Promise<void> {
  if (relayPeers.has(peerId) || !audienceStream) return;
  const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  relayPeers.set(peerId, peer);
  audienceStream.getTracks().forEach((track) => peer.addTrack(track, audienceStream!));
  peer.onicecandidate = (event) => {
    if (event.candidate) postUi({ type: "relay-signal", to: peerId, from: "publisher", data: { type: "ice", candidate: event.candidate } });
  };
  peer.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(peer.connectionState)) closeRelayPeer(peerId);
  };
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  const description = peer.localDescription ?? offer;
  postUi({ type: "relay-signal", to: peerId, from: "publisher", data: { type: "offer", description } });
}

function handleRelaySignal(from: string, data: { type?: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }): void {
  if (!data || typeof data.type !== "string") return;
  if (data.type === "offer") {
    // Viewers never send offers through the relay (the publisher does).
    return;
  }
  if (data.type === "answer" && data.description) {
    const description = data.description;
    void relayPeers.get(from)?.setRemoteDescription(description).catch(() => undefined);
    return;
  }
  if (data.type === "ice" && data.candidate) {
    void relayPeers.get(from)?.addIceCandidate(data.candidate).catch(() => undefined);
    return;
  }
}

async function addRelayPeerIfMissing(peerId: string): Promise<void> {
  if (relayPeers.has(peerId)) return;
  // The relay forwards viewer answers only after our offer, so a stray
  // answer implies we restarted — rebuild the peer.
  await addRelayPeer(peerId);
}

function connectPort(): void {
  const next = browser.runtime.connect({ name: `${PORT_PREFIX}offscreen` });
  port = next;
  next.onDisconnect.addListener(() => {
    if (port !== next) return;
    port = null;
    setTimeout(connectPort, 500);
  });
  next.onMessage.addListener((message: BgMessage) => {
    if (message.type === "relay-signal") handleRelaySignal(message.from, message.data as { type?: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit });
    if (message.type === "relay-closed") closeAllRelayPeers();
    if (message.type === "capture-start") void startCapture(message.streamId);
    if (message.type === "capture-stop") stopCapture();
    if (message.type === "viewer-added") void addViewer(message.viewerId);
    if (message.type === "viewer-removed") closePeer(message.viewerId);
    if (message.type === "rtc-signal") handleSignal(message.from, message.data as { type?: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit });
    if (message.type === "state") {
      const machine = message.state.machine;
      const page = machine.project.pages[machine.session.currentPageIndex];
      latest = {
        screenMode: machine.session.screenMode,
        offlineFallbackActive: machine.session.offlineFallbackPageId !== null && machine.session.offlineFallbackPageId === page?.id,
        privacyMasks: sanitizeAudienceMasks(page?.privacyMasks ?? []),
        maskTitle: machine.project.brand.maskTitle,
        // Blocked = sensitive inputs (password/MFA/file) or origin mismatch —
        // the audience must never watch credentials being entered.
        captureUnsafe: message.state.meta.tabUnsafeOrigin === true || message.state.meta.connectorState?.state === "blocked"
      };
    }
  });
  post({ type: "hello", ctx: "offscreen" });
}

connectPort();
