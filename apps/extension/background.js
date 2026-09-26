import { buildProtectionRules, sanitizeProtectionPaths } from "./request-protection.js";
import { isValidExecutionAction, isValidExpectedCondition, isValidLocator, isValidRecordedAction, isValidStepExecution } from "./recorded-action.js";
import { redactExtensionDiagnostic } from "./extension-diagnostics.js";
import { captureHandoffDecision } from "./tab-handoff.js";

const HOST_NAME = "com.showit.desktop";
const DIAGNOSTIC_STORAGE_KEY = "showit:extension-diagnostics:v1";
const DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DIAGNOSTIC_ENTRIES = 500;
const STATE_STORAGE_KEY = "showit:background-state:v1";
const PROTECTION_RULE_ID_MIN = 910_000;
const PROTECTION_RULE_ID_MAX = 910_100;
let nativePort = null;
let activeSessionId = null;
let recorder = null;
let diagnosticWrite = Promise.resolve();
let captureTabId = null;
let captureActive = false;
let captureOrigin = null;
const sidePanelPorts = new Set();

function persistRuntimeState() {
  void chrome.storage.session.set({ [STATE_STORAGE_KEY]: {
    activeSessionId,
    captureActive,
    captureTabId,
    captureOrigin,
    recorder
  } }).catch(() => undefined);
}

void chrome.storage.session.get(STATE_STORAGE_KEY).then((stored) => {
  const state = stored?.[STATE_STORAGE_KEY];
  if (!state) return;
  if (typeof state.activeSessionId === "string") activeSessionId = state.activeSessionId;
  if (state.captureActive === true && Number.isInteger(state.captureTabId)) {
    void chrome.tabs.get(state.captureTabId).then(() => {
      captureActive = true;
      captureTabId = state.captureTabId;
      captureOrigin = typeof state.captureOrigin === "string" ? state.captureOrigin : null;
    }).catch(() => undefined);
  }
  if (state.recorder && typeof state.recorder.recordingId === "string" && Number.isInteger(state.recorder.tabId)) {
    recorder = { recordingId: state.recorder.recordingId, tabId: state.recorder.tabId, lastUrl: typeof state.recorder.lastUrl === "string" ? state.recorder.lastUrl : "" };
  }
}).catch(() => undefined);

function isAllowedOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function originPattern(origin) {
  return `${new URL(origin).origin}/*`;
}

function connectorScriptId(origin) {
  return `showit_${btoa(origin).replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function sendNative(payload) {
  if (!nativePort) return false;
  try {
    nativePort.postMessage(payload);
    return true;
  } catch {
    return false;
  }
}

function diagnosticTraceId() {
  return `EXT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

async function readExtensionDiagnostics() {
  const stored = await chrome.storage.local.get(DIAGNOSTIC_STORAGE_KEY);
  const threshold = Date.now() - DIAGNOSTIC_RETENTION_MS;
  return Array.isArray(stored[DIAGNOSTIC_STORAGE_KEY])
    ? stored[DIAGNOSTIC_STORAGE_KEY].filter((entry) => entry && typeof entry.traceId === "string" && typeof entry.at === "number" && entry.at >= threshold && typeof entry.area === "string" && typeof entry.message === "string").slice(0, MAX_DIAGNOSTIC_ENTRIES)
    : [];
}

async function flushExtensionDiagnostics() {
  if (!nativePort) return;
  for (const entry of await readExtensionDiagnostics()) sendNative({ type: "extension-diagnostic", ...entry });
}

function recordExtensionDiagnostic(area, error) {
  const entry = { traceId: diagnosticTraceId(), at: Date.now(), area: String(area || "扩展运行时").slice(0, 80), message: redactExtensionDiagnostic(error instanceof Error ? error.message : error) };
  diagnosticWrite = diagnosticWrite
    .then(async () => {
      const entries = await readExtensionDiagnostics();
      await chrome.storage.local.set({ [DIAGNOSTIC_STORAGE_KEY]: [entry, ...entries].slice(0, MAX_DIAGNOSTIC_ENTRIES) });
    })
    .catch(() => undefined);
  sendNative({ type: "extension-diagnostic", ...entry });
}

function safePageUrl(value) {
  try {
    const url = new URL(value);
    return isAllowedOrigin(url.origin) ? `${url.origin}${url.pathname}` : null;
  } catch {
    return null;
  }
}

function allowedPageUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || [...url.searchParams.keys()].some((key) => /(password|passwd|secret|token|cookie|authorization|credential|api[-_]?key)/i.test(key))) return null;
    return isAllowedOrigin(url.origin) ? url.toString() : null;
  } catch {
    return null;
  }
}

async function startRecorder(message) {
  const recordingId = typeof message.recordingId === "string" ? message.recordingId.slice(0, 120) : "";
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!recordingId || !tab?.id || !safePageUrl(tab.url || "")) throw new Error("未找到已授权的活动业务标签。");
  const result = await chrome.tabs.sendMessage(tab.id, { type: "showit-recorder-start", recordingId });
  if (!result?.ok) throw new Error("业务标签未加载 Showit 连接器。");
  recorder = { recordingId, tabId: tab.id, lastUrl: safePageUrl(tab.url || "") };
  persistRuntimeState();
  sendNative({ type: "action-recorder-state", recordingId, active: true, pageTitle: String(result.title || "").slice(0, 160) });
}

async function stopRecorder(message) {
  const current = recorder;
  recorder = null;
  persistRuntimeState();
  if (current?.tabId) await chrome.tabs.sendMessage(current.tabId, { type: "showit-recorder-stop" }).catch(() => undefined);
  sendNative({ type: "action-recorder-state", recordingId: typeof message.recordingId === "string" ? message.recordingId : current?.recordingId || "", active: false });
}

async function waitForCondition(tabId, condition, timeoutSeconds) {
  if (!condition) return { ok: true };
  const deadline = Date.now() + Math.min(30, Math.max(1, Number(timeoutSeconds) || 8)) * 1000;
  while (Date.now() < deadline) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: "showit-check-condition", condition });
      if (result?.ok) return { ok: true };
    } catch {
      // Navigation temporarily detaches the content script; retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ok: false, reason: "预期条件超时" };
}

async function executeRecordedStep(message) {
  const operationId = typeof message.operationId === "string" ? message.operationId.slice(0, 120) : "";
  const sessionId = typeof message.sessionId === "string" ? message.sessionId.slice(0, 120) : "";
  const stepId = typeof message.stepId === "string" ? message.stepId.slice(0, 120) : "";
  const execution = isValidStepExecution(message.execution) ? message.execution : "hint";
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!operationId || !sessionId || !stepId || !tab?.id) throw new Error("步骤执行上下文无效。");
  if (!isValidExecutionAction(message.action) || !isValidExpectedCondition(message.expectedCondition)) throw new Error("录制动作或预期条件无效。");
  let result;
  if (message.action?.type === "navigate") {
    const url = allowedPageUrl(message.action.url);
    if (!url || execution !== "auto") result = { ok: execution !== "auto", performed: "highlight", reason: execution === "auto" ? "导航 URL 无效" : undefined };
    else {
      await chrome.tabs.update(tab.id, { url });
      result = { ok: true, performed: "navigate" };
    }
  } else {
    result = await chrome.tabs.sendMessage(tab.id, { type: "showit-execute-action", action: message.action, execution });
  }
  if (!result?.ok) {
    sendNative({ type: "recorded-step-result", operationId, sessionId, stepId, ok: false, reason: String(result?.reason || "动作执行失败").slice(0, 200) });
    return;
  }
  const condition = await waitForCondition(tab.id, message.expectedCondition, message.conditionTimeoutSeconds);
  sendNative({ type: "recorded-step-result", operationId, sessionId, stepId, ok: condition.ok, verified: Boolean(message.expectedCondition), ...(condition.reason ? { reason: condition.reason } : {}) });
}

async function pickPrivacyMask(message) {
  const requestId = typeof message.requestId === "string" ? message.requestId.slice(0, 120) : "";
  const sessionId = typeof message.sessionId === "string" ? message.sessionId.slice(0, 120) : "";
  const pageId = typeof message.pageId === "string" ? message.pageId.slice(0, 120) : "";
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!requestId || !sessionId || !pageId || !tab?.id || !safePageUrl(tab.url || "")) throw new Error("隐私遮罩选择上下文无效。");
  const result = await chrome.tabs.sendMessage(tab.id, { type: "showit-pick-privacy-mask" });
  sendNative({ type: "privacy-mask-picked", requestId, sessionId, pageId, ok: result?.ok === true, locator: result?.locator, bounds: result?.bounds, reason: typeof result?.reason === "string" ? result.reason.slice(0, 200) : undefined });
}

async function resolvePrivacyMasks(message) {
  const sessionId = typeof message.sessionId === "string" ? message.sessionId.slice(0, 120) : "";
  const pageId = typeof message.pageId === "string" ? message.pageId.slice(0, 120) : "";
  const items = Array.isArray(message.items) ? message.items.slice(0, 30).filter((item) => item && typeof item.id === "string" && isValidLocator(item.locator)) : [];
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!sessionId || !pageId || items.length === 0 || !tab?.id || !safePageUrl(tab.url || "")) throw new Error("绑定遮罩解析上下文无效。");
  const result = await chrome.tabs.sendMessage(tab.id, { type: "showit-resolve-privacy-masks", items });
  sendNative({ type: "privacy-mask-resolution", sessionId, pageId, ok: result?.ok === true, resolved: result?.resolved, missing: result?.missing });
}

async function cancelPrivacyMaskPicker() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: "showit-cancel-privacy-mask" }).catch(() => undefined);
}

async function currentProtectionRuleIds() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return rules.map((rule) => rule.id).filter((id) => id >= PROTECTION_RULE_ID_MIN && id < PROTECTION_RULE_ID_MAX);
}

async function configureRequestProtection(message) {
  const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
  const origin = typeof message.origin === "string" && isAllowedOrigin(message.origin) ? new URL(message.origin).origin : null;
  const securityMode = message.securityMode === "request-protection" ? "request-protection" : "interactive";
  const allowedPaths = sanitizeProtectionPaths([...(Array.isArray(message.loginPaths) ? message.loginPaths : []), ...(Array.isArray(message.logoutPaths) ? message.logoutPaths : [])]);
  const removeRuleIds = await currentProtectionRuleIds();
  if (!origin || securityMode === "interactive") {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    sendNative({ type: "request-protection-state", sessionId, enabled: false });
    return;
  }

  const addRules = buildProtectionRules(origin, allowedPaths);
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  sendNative({ type: "request-protection-state", sessionId, enabled: true, origin, allowedPaths: allowedPaths.length });
}

async function probeActiveTab(sessionId, connectorIdValue, originValue) {
  activeSessionId = sessionId;
  persistRuntimeState();
  const connectorId = typeof connectorIdValue === "string" ? connectorIdValue.slice(0, 120) : "";
  const expectedOrigin = typeof originValue === "string" && isAllowedOrigin(originValue) ? new URL(originValue).origin : "";
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !tab.url) {
    sendNative({ type: "connector-probe", sessionId, connectorId, origin: expectedOrigin, state: "error", reason: "未找到活动业务标签。" });
    return;
  }
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: "showit-probe" });
    if (!result || !isAllowedOrigin(result.origin) || (expectedOrigin && new URL(result.origin).origin !== expectedOrigin)) throw new Error("活动业务标签与当前连接器不匹配。");
    sendNative({
      type: "connector-probe",
      sessionId,
      connectorId,
      origin: result.origin,
      title: typeof result.title === "string" ? result.title.slice(0, 300) : "",
      hasPasswordField: result.hasPasswordField === true,
      privacyRisk: ["password", "file", "mfa", "sso"].includes(result.privacyRisk) ? result.privacyRisk : null
    });
  } catch (error) {
    recordExtensionDiagnostic("探测活动业务标签", error);
    sendNative({ type: "connector-probe", sessionId, connectorId, origin: expectedOrigin, state: "blocked", reason: error instanceof Error ? error.message.slice(0, 200) : "业务标签探测失败。" });
  }
}

function broadcast(message) {
  for (const port of sidePanelPorts) {
    try {
      port.postMessage(message);
    } catch {
      sidePanelPorts.delete(port);
    }
  }
}

async function ensureHost() {
  if (nativePort) return nativePort;
  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
    nativePort.onMessage.addListener((message) => {
      if (message?.type === "probe-active-tab" && typeof message.sessionId === "string") {
        void probeActiveTab(message.sessionId, message.connectorId, message.origin);
      }
      if (message?.type === "configure-request-protection") {
        void configureRequestProtection(message).catch((error) => {
          recordExtensionDiagnostic("配置请求保护", error);
          sendNative({ type: "request-protection-state", sessionId: message.sessionId, enabled: false, reason: error instanceof Error ? error.message.slice(0, 200) : "请求保护规则配置失败。" });
        });
      }
      if (message?.type === "start-action-recorder") {
        void startRecorder(message).catch((error) => {
          recordExtensionDiagnostic("启动操作录制", error);
          sendNative({ type: "action-recorder-state", recordingId: message.recordingId, active: false, reason: error instanceof Error ? error.message.slice(0, 200) : "操作录制无法启动。" });
        });
      }
      if (message?.type === "stop-action-recorder") void stopRecorder(message);
      if (message?.type === "execute-recorded-step") {
        void executeRecordedStep(message).catch((error) => {
          recordExtensionDiagnostic("执行录制步骤", error);
          sendNative({ type: "recorded-step-result", operationId: message.operationId, sessionId: message.sessionId, stepId: message.stepId, ok: false, reason: error instanceof Error ? error.message.slice(0, 200) : "步骤执行失败。" });
        });
      }
      if (message?.type === "pick-privacy-mask") {
        void pickPrivacyMask(message).catch((error) => {
          recordExtensionDiagnostic("选择隐私遮罩", error);
          sendNative({ type: "privacy-mask-picked", requestId: message.requestId, sessionId: message.sessionId, pageId: message.pageId, ok: false, reason: error instanceof Error ? error.message.slice(0, 200) : "无法选择遮罩元素。" });
        });
      }
      if (message?.type === "resolve-privacy-masks") {
        void resolvePrivacyMasks(message).catch((error) => {
          recordExtensionDiagnostic("解析隐私遮罩", error);
          sendNative({ type: "privacy-mask-resolution", sessionId: message.sessionId, pageId: message.pageId, ok: false, reason: error instanceof Error ? error.message.slice(0, 200) : "绑定遮罩解析失败。" });
        });
      }
      if (message?.type === "cancel-privacy-mask-picker") void cancelPrivacyMaskPicker();
      broadcast({ type: "native-message", payload: message });
    });
    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
      broadcast({ type: "native-disconnected" });
    });
    void flushExtensionDiagnostics().catch(() => undefined);
    return nativePort;
  } catch (error) {
    nativePort = null;
    return null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

async function registerOrigin(origin) {
  const matches = [originPattern(origin)];
  const id = connectorScriptId(origin);
  await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => undefined);
  await chrome.scripting.registerContentScripts([
    { id, matches, js: ["content-script.js"], runAt: "document_idle", persistAcrossSessions: true }
  ]);
  const tabs = await chrome.tabs.query({ url: matches });
  await Promise.all(
    tabs
      .filter((tab) => typeof tab.id === "number")
      .map((tab) => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-script.js"] }))
  );
}

async function handoffCapture(tabId) {
  if (!captureActive) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = safePageUrl(tab.url || "");
    const origin = url ? new URL(url).origin : null;
    const granted = origin ? await chrome.permissions.contains({ origins: [originPattern(origin)] }) : false;
    if (tabId === captureTabId) {
      if (origin === captureOrigin) return;
      if (!origin || !granted) {
        sendNative({ type: "connector-navigation", sessionId: activeSessionId, state: "blocked", reason: origin ? "新业务域名尚未授权，观众屏已进入隐私保护。" : "当前标签不在安全业务地址范围内。", ...(origin ? { origin } : {}) });
        broadcast({ type: "origin-authorization-required", origin });
        return;
      }
      const probe = await chrome.tabs.sendMessage(tabId, { type: "showit-probe" }).catch(() => null);
      const privacyRisk = ["password", "file", "mfa", "sso"].includes(probe?.privacyRisk) ? probe.privacyRisk : null;
      if (privacyRisk || probe?.hasPasswordField === true) {
        sendNative({ type: "connector-navigation", sessionId: activeSessionId, state: "blocked", reason: "新标签包含登录或敏感输入，观众屏保持隐私保护。", origin });
        return;
      }
      const originChanged = captureOrigin !== null;
      captureOrigin = origin;
      persistRuntimeState();
      if (originChanged) sendNative({ type: "connector-navigation", sessionId: activeSessionId, state: "ready", origin, title: String(tab.title || "").slice(0, 300) });
      return;
    }
    const decision = captureHandoffDecision(captureTabId, tabId, tab.url || "", granted);
    if (decision === "ignore") return;
    if (decision !== "handoff") {
      sendNative({ type: "connector-navigation", sessionId: activeSessionId, state: "blocked", reason: decision === "authorize" ? "新业务域名尚未授权，观众屏已进入隐私保护。" : "当前标签不在安全业务地址范围内。", ...(origin ? { origin } : {}) });
      broadcast({ type: "origin-authorization-required", origin });
      return;
    }
    const probe = await chrome.tabs.sendMessage(tabId, { type: "showit-probe" }).catch(() => null);
    const privacyRisk = ["password", "file", "mfa", "sso"].includes(probe?.privacyRisk) ? probe.privacyRisk : null;
    if (privacyRisk || probe?.hasPasswordField === true) {
      sendNative({ type: "connector-navigation", sessionId: activeSessionId, state: "blocked", reason: "新标签包含登录或敏感输入，观众屏保持隐私保护。", origin });
      return;
    }
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    captureTabId = tabId;
    captureOrigin = origin;
    persistRuntimeState();
    broadcast({ type: "capture-handoff", streamId, tabId, tabTitle: tab.title ?? "业务标签" });
    sendNative({ type: "connector-navigation", sessionId: activeSessionId, state: "ready", origin, title: String(tab.title || "").slice(0, 300) });
  } catch (error) {
    recordExtensionDiagnostic("切换投送标签", error);
    sendNative({ type: "connector-navigation", sessionId: activeSessionId, state: "blocked", reason: "新标签尚未准备完成，观众屏已进入隐私保护。" });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "showit-side-panel") return;
  sidePanelPorts.add(port);
  port.onDisconnect.addListener(() => {
    sidePanelPorts.delete(port);
    if (sidePanelPorts.size === 0) {
      captureActive = false;
      captureTabId = null;
    }
  });
  port.onMessage.addListener(async (message) => {
    if (message?.type === "connect-native") {
      const host = await ensureHost();
      port.postMessage({ type: host ? "native-connected" : "native-unavailable" });
      return;
    }
    if (message?.type === "native-command") {
      const host = await ensureHost();
      if (host && message.payload && typeof message.payload.type === "string") sendNative(message.payload);
    }
    if (message?.type === "capture-state") {
      captureActive = message.active === true;
      captureTabId = captureActive && Number.isInteger(message.tabId) ? message.tabId : null;
      captureOrigin = null;
      if (captureTabId !== null) {
        void chrome.tabs.get(captureTabId).then((tab) => {
          const url = safePageUrl(tab.url || "");
          if (url) captureOrigin = new URL(url).origin;
          persistRuntimeState();
        }).catch(() => undefined);
      }
      persistRuntimeState();
    }
    if (message?.type === "request-origin") {
      const origin = message.origin;
      if (typeof origin === "string" && isAllowedOrigin(origin)) {
        const granted = await chrome.permissions.request({ origins: [originPattern(origin)] });
        if (granted) await registerOrigin(origin);
        port.postMessage({ type: "origin-permission", origin, granted });
      } else {
        port.postMessage({ type: "origin-permission", origin, granted: false });
      }
    }
    if (message?.type === "request-tab-capture") {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) {
        port.postMessage({ type: "capture-error", reason: "未找到可投送的业务标签。" });
        return;
      }
      try {
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        port.postMessage({ type: "capture-stream-id", streamId, tabId: tab.id, tabTitle: tab.title ?? "业务标签" });
      } catch (error) {
        recordExtensionDiagnostic("捕获业务标签", error);
        port.postMessage({ type: "capture-error", reason: error instanceof Error ? error.message : "无法捕获当前标签。" });
      }
    }
  });
});

self.addEventListener("unhandledrejection", (event) => recordExtensionDiagnostic("未处理 Promise", event.reason));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "showit-resource-failures") {
    const origin = typeof message.origin === "string" ? message.origin : sender.origin;
    const count = Number.isInteger(message.count) ? Math.min(10_000, Math.max(0, message.count)) : 0;
    const isCapturedTab = !captureActive || sender.tab?.id === captureTabId;
    if (!activeSessionId || !origin || !count || !isCapturedTab || !isAllowedOrigin(origin)) return;
    sendNative({ type: "connector-resource-failures", sessionId: activeSessionId, origin, count });
    return;
  }
  if (message?.type === "showit-privacy-risk") {
    const origin = typeof message.origin === "string" ? message.origin : sender.origin;
    const privacyRisk = ["password", "file", "mfa", "sso"].includes(message.privacyRisk) ? message.privacyRisk : null;
    const isCapturedTab = !captureActive || sender.tab?.id === captureTabId;
    if (!origin || !privacyRisk || !isCapturedTab || !isAllowedOrigin(origin)) return;
    sendNative({ type: "connector-probe", sessionId: activeSessionId, origin, privacyRisk, state: privacyRisk === "file" ? "blocked" : "anonymous" });
    return;
  }
  if (message?.type === "showit-recorded-action") {
    if (!recorder || sender.tab?.id !== recorder.tabId || message.recordingId !== recorder.recordingId || !isValidRecordedAction(message.action)) return;
    sendNative({ type: "recorded-action", recordingId: recorder.recordingId, action: message.action });
    sendResponse({ accepted: true });
    return;
  }
  if (message?.type !== "business-page-message") return;
  const origin = typeof message.origin === "string" ? message.origin : sender.origin;
  if (!origin || !isAllowedOrigin(origin)) return;
  const payload = {
    type: "business-page-message",
    sessionId: activeSessionId,
    origin,
    tabId: sender.tab?.id ?? null,
    title: typeof message.title === "string" ? message.title.slice(0, 300) : "",
    payload: message.payload
  };
  sendNative(payload);
  broadcast({ type: "business-page-message", payload });
  sendResponse({ accepted: true });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (captureActive && tab.active && changeInfo.status === "complete") void handoffCapture(tabId);
  if (!recorder || recorder.tabId !== tabId || changeInfo.status !== "complete") return;
  const url = safePageUrl(tab.url || "");
  if (!url || url === recorder.lastUrl) return;
  recorder.lastUrl = url;
  sendNative({ type: "recorded-action", recordingId: recorder.recordingId, action: { type: "navigate", url } });
  chrome.tabs.sendMessage(tabId, { type: "showit-recorder-start", recordingId: recorder.recordingId }).catch(() => undefined);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void handoffCapture(tabId);
});
