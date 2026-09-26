import { Room, RoomEvent, Track } from "livekit-client";
import { createAudienceCompositor, sanitizeAudienceMasks } from "./audience-compositor.js";

const status = document.querySelector("#native-status");
const title = document.querySelector("#page-title");
const meta = document.querySelector("#page-meta");
const originForm = document.querySelector("#origin-form");
const originInput = document.querySelector("#origin");
const originStatus = document.querySelector("#origin-status");
const captureButton = document.querySelector("#capture");
const stopCaptureButton = document.querySelector("#stop-capture");
const totalTime = document.querySelector("#total-time");
const pageTime = document.querySelector("#page-time");
const stepText = document.querySelector("#step-text");
const stepCounter = document.querySelector("#step-counter");
let port = null;
let panelReconnectTimer = null;
let panelReconnectAttempt = 0;
let sessionStateKnown = false;
let lastCaptureTabId = null;
let audienceSignalUrl = "";
let audienceDeliveryMode = "p2p";
let audienceSfuUrl = "";
let audienceSfuToken = "";
let activeSessionId = "";
let captureStream = null;
let audienceStream = null;
let audienceCompositor = null;
let signalSocket = null;
let sfuRoom = null;
let signalReconnectTimer = null;
let signalReconnectAttempt = 0;
let currentScreenMode = "privacy";
let currentOfflineFallbackActive = false;
let currentPrivacyMasks = [];
let timerState = { timerStatus: "idle", totalElapsedMs: 0, pageElapsedMs: 0, timerStartedAt: null };
const peers = new Map();

function schedulePanelReconnect() {
  if (panelReconnectTimer) return;
  const delay = Math.min(10_000, 500 * 2 ** Math.min(panelReconnectAttempt++, 5));
  panelReconnectTimer = setTimeout(() => {
    panelReconnectTimer = null;
    if (!chrome.runtime?.id) {
      status.textContent = "扩展已重新加载，请刷新面板页面。";
      return;
    }
    try {
      connectPanelPort();
    } catch {
      schedulePanelReconnect();
    }
  }, delay);
}

function connectPanelPort() {
  const nextPort = chrome.runtime.connect({ name: "showit-side-panel" });
  nextPort.onMessage.addListener(handlePanelMessage);
  nextPort.onDisconnect.addListener(() => {
    if (port !== nextPort) return;
    port = null;
    status.textContent = "与后台连接中断，正在重连…";
    schedulePanelReconnect();
  });
  port = nextPort;
  panelReconnectAttempt = 0;
  try {
    nextPort.postMessage({ type: "connect-native" });
    if (captureStream && lastCaptureTabId !== null) nextPort.postMessage({ type: "capture-state", active: true, tabId: lastCaptureTabId });
  } catch {
    schedulePanelReconnect();
  }
  return nextPort;
}

function postToPort(payload) {
  try {
    port?.postMessage(payload);
  } catch {
    schedulePanelReconnect();
  }
}

connectPanelPort();

function handlePanelMessage(message) {
  if (message.type === "native-connected") status.textContent = "桌面端已连接";
  if (message.type === "native-unavailable") status.textContent = "等待桌面端";
  if (message.type === "native-disconnected") status.textContent = "桌面端断开";
  if (message.type === "native-message" && message.payload?.pageTitle) {
    title.textContent = message.payload.pageTitle;
    meta.textContent = message.payload.meta ?? "会话已同步";
  }
  if (message.type === "native-message" && message.payload?.type === "session-state") {
    activeSessionId = message.payload.sessionId || "";
    title.textContent = message.payload.pageTitle || "等待演示会话";
    meta.textContent = `${message.payload.pageIndex + 1}/${message.payload.pageCount} · ${message.payload.meta || "会话已同步"}`;
    stepText.textContent = message.payload.stepText || "本页步骤已完成";
    stepCounter.textContent = `步骤 ${Math.min((message.payload.stepIndex || 0) + 1, message.payload.stepCount || 0)}/${message.payload.stepCount || 0}`;
    timerState = {
      timerStatus: message.payload.timerStatus,
      totalElapsedMs: Number(message.payload.totalElapsedMs) || 0,
      pageElapsedMs: Number(message.payload.pageElapsedMs) || 0,
      timerStartedAt: typeof message.payload.timerStartedAt === "number" ? message.payload.timerStartedAt : null
    };
    currentScreenMode = ["normal", "black", "white", "frozen", "privacy", "ended"].includes(message.payload.screenMode) ? message.payload.screenMode : "privacy";
    sessionStateKnown = true;
    currentOfflineFallbackActive = message.payload.offlineFallbackActive === true;
    currentPrivacyMasks = sanitizeAudienceMasks(message.payload.privacyMasks);
    updateCapturePrivacy();
    renderTimer();
  }
  if (message.type === "business-page-message") {
    title.textContent = message.payload?.title || "业务页面已就绪";
    meta.textContent = message.payload?.origin || "已接收业务页面状态";
  }
  if (message.type === "origin-permission") {
    originStatus.textContent = message.granted ? `已授权 ${message.origin}` : "站点授权被拒绝或 URL 不受支持";
  }
  if (message.type === "origin-authorization-required") {
    originInput.value = message.origin || "";
    originStatus.textContent = message.origin ? `新站点等待授权：${message.origin}` : "当前标签地址不受支持";
  }
  if (message.type === "native-message" && message.payload?.type === "audience-share") {
    const nextSignalUrl = message.payload.signalUrl || "";
    const nextDeliveryMode = message.payload.deliveryMode === "sfu" ? "sfu" : "p2p";
    const nextSfuUrl = message.payload.sfuUrl || "";
    const nextSfuToken = message.payload.sfuToken || "";
    const changed = audienceSignalUrl !== nextSignalUrl || audienceDeliveryMode !== nextDeliveryMode || audienceSfuUrl !== nextSfuUrl || audienceSfuToken !== nextSfuToken;
    audienceSignalUrl = nextSignalUrl;
    audienceDeliveryMode = nextDeliveryMode;
    audienceSfuUrl = nextSfuUrl;
    audienceSfuToken = nextSfuToken;
    const ready = audienceDeliveryMode === "sfu" ? Boolean(audienceSfuUrl && audienceSfuToken) : Boolean(audienceSignalUrl);
    if (!ready) stopCapture();
    else if (changed && captureStream) connectPublisher();
    captureButton.disabled = !ready;
    meta.textContent = ready ? "局域网观众屏已准备，选择业务标签后开始投送。" : "局域网观众分享未启动。";
  }
  if (message.type === "capture-stream-id" || message.type === "capture-handoff") startCapture(message.streamId, message.tabTitle, message.tabId);
  if (message.type === "capture-error") meta.textContent = message.reason;
}

function formatTime(value) {
  const seconds = Math.max(0, Math.floor(value / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function renderTimer() {
  const ticking = timerState.timerStatus === "running" && timerState.timerStartedAt !== null ? Math.max(0, Date.now() - timerState.timerStartedAt) : 0;
  totalTime.textContent = formatTime(timerState.totalElapsedMs + ticking);
  pageTime.textContent = formatTime(timerState.pageElapsedMs + ticking);
}

setInterval(renderTimer, 500);

function command(type) {
  postToPort({ type: "native-command", payload: { type, sessionId: activeSessionId, commandId: `${Date.now().toString(36)}-${crypto.randomUUID()}` } });
}

originForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const origin = new URL(originInput.value).origin;
    postToPort({ type: "request-origin", origin });
  } catch {
    originStatus.textContent = "请输入完整 HTTPS 或本机开发 URL";
  }
});

async function ensureAudiencePermission() {
  const endpoint = audienceDeliveryMode === "sfu" ? audienceSfuUrl : audienceSignalUrl;
  if (!endpoint) return false;
  try {
    const url = new URL(endpoint);
    const origin = `${url.protocol === "wss:" ? "https" : "http"}://${url.hostname}/*`;
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

captureButton.addEventListener("click", async () => {
  if (audienceDeliveryMode === "sfu" ? !audienceSfuUrl || !audienceSfuToken : !audienceSignalUrl) return;
  if (!await ensureAudiencePermission()) {
    meta.textContent = "需要局域网投送权限后才能开始。";
    return;
  }
  postToPort({ type: "request-tab-capture" });
});

stopCaptureButton.addEventListener("click", stopCapture);

async function startCapture(streamId, tabTitle, tabId) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      }
    });
    stopCapture();
    captureStream = stream;
    lastCaptureTabId = Number.isInteger(tabId) ? tabId : null;
    audienceCompositor = createAudienceCompositor(stream, () => ({ screenMode: currentScreenMode, offlineFallbackActive: currentOfflineFallbackActive, privacyMasks: currentPrivacyMasks }));
    audienceStream = audienceCompositor.stream;
    updateCapturePrivacy();
    postToPort({ type: "capture-state", active: true, tabId });
    connectPublisher();
    captureButton.disabled = true;
    stopCaptureButton.disabled = false;
    title.textContent = tabTitle || "业务标签投送中";
    meta.textContent = "正在向局域网观众投送标签画面。";
    stream.getVideoTracks().forEach((track) => track.addEventListener("ended", () => {
      if (captureStream === stream) stopCapture();
    }, { once: true }));
  } catch (error) {
    stopCapture();
    meta.textContent = error instanceof Error ? error.message : "标签捕获被拒绝或不可用。";
  }
}

function connectPublisher() {
  if (audienceDeliveryMode === "sfu") {
    void connectSfuPublisher();
    return;
  }
  connectP2pPublisher();
}

function schedulePublisherReconnect(message) {
  if (!captureStream || signalReconnectTimer) return;
  meta.textContent = message;
  const delay = Math.min(10_000, 500 * (2 ** Math.min(signalReconnectAttempt++, 5)));
  signalReconnectTimer = setTimeout(() => {
    signalReconnectTimer = null;
    connectPublisher();
  }, delay);
}

async function connectSfuPublisher() {
  if (!captureStream || !audienceStream || !audienceSfuUrl || !audienceSfuToken) return;
  if (signalReconnectTimer) {
    clearTimeout(signalReconnectTimer);
    signalReconnectTimer = null;
  }
  for (const audienceId of peers.keys()) closePeer(audienceId);
  if (signalSocket) {
    signalSocket.onclose = null;
    signalSocket.close();
  }
  signalSocket = null;
  if (sfuRoom) {
    sfuRoom.removeAllListeners();
    await sfuRoom.disconnect();
  }
  const room = new Room({ adaptiveStream: true, dynacast: true });
  sfuRoom = room;
  room.on(RoomEvent.Reconnecting, () => { meta.textContent = "SFU 连接中断，正在恢复投送。"; });
  room.on(RoomEvent.Reconnected, () => { signalReconnectAttempt = 0; meta.textContent = "正在通过本地 SFU 投送标签画面。"; });
  room.on(RoomEvent.Disconnected, () => {
    if (sfuRoom !== room) return;
    sfuRoom = null;
    schedulePublisherReconnect("SFU 连接断开，正在恢复投送。");
  });
  try {
    await room.connect(audienceSfuUrl, audienceSfuToken, { autoSubscribe: false });
    if (sfuRoom !== room || !captureStream || !audienceStream) return;
    const videoTrack = audienceStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error("没有可投送的视频轨道。");
    await room.localParticipant.publishTrack(videoTrack, {
      source: Track.Source.ScreenShare,
      simulcast: true,
      videoCodec: "vp8"
    });
    signalReconnectAttempt = 0;
    meta.textContent = "正在通过本地 SFU 投送标签画面。";
  } catch (error) {
    if (sfuRoom === room) sfuRoom = null;
    room.removeAllListeners();
    await room.disconnect();
    schedulePublisherReconnect(error instanceof Error ? `SFU 投送失败：${error.message}` : "SFU 投送失败，正在重试。");
  }
}

function connectP2pPublisher() {
  if (!captureStream || !audienceStream || !audienceSignalUrl) return;
  if (signalReconnectTimer) {
    clearTimeout(signalReconnectTimer);
    signalReconnectTimer = null;
  }
  if (sfuRoom) {
    sfuRoom.removeAllListeners();
    void sfuRoom.disconnect();
    sfuRoom = null;
  }
  const peerId = `publisher-${Math.random().toString(36).slice(2)}`;
  const socket = new WebSocket(`${audienceSignalUrl}/${peerId}`);
  signalSocket = socket;
  socket.onopen = () => {
    signalReconnectAttempt = 0;
    meta.textContent = "正在向局域网观众投送标签画面。";
  };
  socket.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    if (message.to && message.to !== peerId && message.to !== "publisher") return;
    if (message.type === "join" && message.from) await createPeer(message.from);
    if (message.type === "answer" && message.from && peers.has(message.from)) await peers.get(message.from).setRemoteDescription(message.description);
    if (message.type === "ice" && message.from && message.candidate && peers.has(message.from)) await peers.get(message.from).addIceCandidate(message.candidate).catch(() => undefined);
    if (message.type === "preference" && message.from && peers.has(message.from)) await applyPeerQuality(message.from, message.mode);
    if (message.type === "leave" && message.from && peers.has(message.from)) closePeer(message.from);
  };
  socket.onclose = () => {
    if (signalSocket !== socket) return;
    signalSocket = null;
    for (const audienceId of peers.keys()) closePeer(audienceId);
    if (!audienceSignalUrl) return;
    schedulePublisherReconnect("信令连接断开，正在恢复投送。");
  };
}

async function createPeer(audienceId) {
  if (!captureStream || !audienceStream || peers.has(audienceId) || !signalSocket || signalSocket.readyState !== WebSocket.OPEN) return;
  const peer = new RTCPeerConnection({ iceServers: [] });
  peers.set(audienceId, peer);
  audienceStream.getTracks().forEach((track) => peer.addTrack(track, audienceStream));
  peer.onicecandidate = (event) => {
    if (event.candidate && signalSocket?.readyState === WebSocket.OPEN) signalSocket.send(JSON.stringify({ type: "ice", to: audienceId, candidate: event.candidate }));
  };
  peer.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(peer.connectionState)) closePeer(audienceId);
  };
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  if (!signalSocket || signalSocket.readyState !== WebSocket.OPEN) {
    closePeer(audienceId);
    return;
  }
  signalSocket.send(JSON.stringify({ type: "offer", to: audienceId, description: peer.localDescription }));
}

async function applyPeerQuality(audienceId, mode) {
  const peer = peers.get(audienceId);
  const sender = peer?.getSenders().find((item) => item.track?.kind === "video");
  if (!sender) return;
  const parameters = sender.getParameters();
  parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
  const encoding = parameters.encodings[0];
  if (mode === "low") {
    encoding.maxBitrate = 900_000;
    encoding.scaleResolutionDownBy = 2;
  } else if (mode === "high") {
    encoding.maxBitrate = 4_000_000;
    encoding.scaleResolutionDownBy = 1;
  } else {
    delete encoding.maxBitrate;
    encoding.scaleResolutionDownBy = 1;
  }
  await sender.setParameters(parameters).catch(() => undefined);
}

function updateCapturePrivacy() {
  const visible = sessionStateKnown && currentScreenMode !== "privacy" && !currentOfflineFallbackActive;
  captureStream?.getVideoTracks().forEach((track) => {
    track.enabled = visible;
  });
}

function closePeer(audienceId) {
  peers.get(audienceId)?.close();
  peers.delete(audienceId);
}

function stopCapture() {
  const ownedCapture = captureStream !== null;
  if (signalReconnectTimer) {
    clearTimeout(signalReconnectTimer);
    signalReconnectTimer = null;
  }
  signalReconnectAttempt = 0;
  captureStream?.getTracks().forEach((track) => track.stop());
  captureStream = null;
  audienceCompositor?.stop();
  audienceCompositor = null;
  audienceStream = null;
  for (const audienceId of peers.keys()) closePeer(audienceId);
  if (signalSocket) {
    signalSocket.onclose = null;
    signalSocket.close();
  }
  signalSocket = null;
  if (sfuRoom) {
    sfuRoom.removeAllListeners();
    void sfuRoom.disconnect();
    sfuRoom = null;
  }
  if (ownedCapture) postToPort({ type: "capture-state", active: false });
  captureButton.disabled = audienceDeliveryMode === "sfu" ? !audienceSfuUrl || !audienceSfuToken : !audienceSignalUrl;
  stopCaptureButton.disabled = true;
}

document.querySelector("#prev").addEventListener("click", () => {
  command("goto-prev");
});

document.querySelector("#next").addEventListener("click", () => {
  command("goto-next");
});

document.querySelector("#prev-step").addEventListener("click", () => command("goto-prev-step"));
document.querySelector("#next-step").addEventListener("click", () => command("goto-next-step"));

document.querySelector("#open-showit").addEventListener("click", () => {
  command("focus-showit");
});
