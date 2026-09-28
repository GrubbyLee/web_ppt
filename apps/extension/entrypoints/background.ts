import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import type { PresentationConnector, PresentationPage, Project, RecordedAction } from "@showit/contracts";
import { applyAction, autoAdvanceElapsedMs, initialMachineState, type MachineState, type SessionAction } from "@/session/machine";
import { beginPresentationLaunch } from "@/lib/presentation-launch";
import { mergePresenterEditsIntoWorkspace } from "@/lib/presenter-edits";
import { clearRuntimeSecrets, missingRuntimeSecrets, setRuntimeSecrets } from "@/lib/runtime-secrets";
import { resolveRecordedAction } from "@/lib/step-action";
import { canAutoContinueAfterVerification } from "@/lib/step-runtime";
import { resolveUrlTemplate } from "@/lib/template";
import { isOfflineFallbackReady } from "@/lib/offline-fallback";
import { buildProtectionRules, sanitizeProtectionPaths } from "@/lib/request-protection";
import { isValidExecutionAction, isValidExpectedCondition, isValidRecordedAction, isValidStepExecution } from "@/lib/recorded-action";
import { captureHandoffDecision } from "@/lib/tab-handoff";
import { redactExtensionDiagnostic } from "@/lib/redact";
import { kvSessionGet, kvSessionRemove, kvSessionSet } from "@/lib/kv";
import { loadWorkspace, saveRehearsal, saveWorkspace } from "@/lib/persistence";
import { projectTrustState } from "@/lib/project-trust";
import type { BgMessage, BroadcastMeta, BroadcastState, ConnectorRuntimeState, OverlayState, StepExecutionStatus, UiMessage } from "@/messaging/protocol";
import { PORT_PREFIX } from "@/messaging/protocol";

const MACHINE_SNAPSHOT_KEY = "showit:machine-snapshot:v1";
const DIAGNOSTIC_STORAGE_KEY = "showit:extension-diagnostics:v1";
const DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DIAGNOSTIC_ENTRIES = 500;
const PROTECTION_RULE_ID_MIN = 910_000;
const PROTECTION_RULE_ID_MAX = 910_100;
const CONTENT_SCRIPT_FILE = "/business-tab.js";
const AUTHORIZE_CAPTURE_MENU_ID = "showit-authorize-capture";
const OFFSCREEN_URL = "/offscreen.html";

type ViewerEntry = {
  viewerId: string;
  status: "connecting" | "connected" | "failed";
};

type RecorderState = {
  recordingId: string;
  tabId: number;
  lastUrl: string;
};

let machine: MachineState | null = null;
const runtime = {
  sessionWindowId: null as number | null,
  sessionTabId: null as number | null,
  tabKind: null as "business" | "stage" | null,
  tabStatus: null as "loading" | "complete" | "error" | null,
  tabUnsafeOrigin: false,
  connectorState: null as ConnectorRuntimeState | null,
  stepExecution: null as StepExecutionStatus | null,
  offlineOriginRequest: null as string | null,
  message: null as string | null,
  lastTickBlocked: true
};
let recorder: RecorderState | null = null;
let viewers = new Map<string, ViewerEntry>();
const audienceWindows = new Map<string, number>();
let captureActive = false;
let offscreenReady = false;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let boundMaskResolveTimer: ReturnType<typeof setTimeout> | null = null;

type UiPort = {
  ctx: string;
  viewerId?: string;
  port: Browser.runtime.Port;
};

const uiPorts = new Set<UiPort>();

// ---- diagnostics --------------------------------------------------------------

function diagnosticTraceId(): string {
  return `EXT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

async function readDiagnostics(): Promise<Array<{ traceId: string; at: number; area: string; message: string }>> {
  const stored = await browser.storage.local.get(DIAGNOSTIC_STORAGE_KEY);
  const threshold = Date.now() - DIAGNOSTIC_RETENTION_MS;
  const entries = stored[DIAGNOSTIC_STORAGE_KEY];
  return (Array.isArray(entries) ? entries : [])
    .filter((entry: unknown) => Boolean(entry) && typeof entry === "object" && typeof (entry as { traceId?: unknown }).traceId === "string" && typeof (entry as { at?: unknown }).at === "number" && (entry as { at: number }).at >= threshold)
    .slice(0, MAX_DIAGNOSTIC_ENTRIES) as Array<{ traceId: string; at: number; area: string; message: string }>;
}

function recordDiagnostic(area: string, error: unknown): void {
  const entry = {
    traceId: diagnosticTraceId(),
    at: Date.now(),
    area: String(area || "扩展运行时").slice(0, 80),
    message: redactExtensionDiagnostic(error instanceof Error ? error.message : error)
  };
  void readDiagnostics()
    .then((entries) => browser.storage.local.set({ [DIAGNOSTIC_STORAGE_KEY]: [entry, ...entries].slice(0, MAX_DIAGNOSTIC_ENTRIES) }))
    .catch(() => undefined);
}

// ---- helpers ------------------------------------------------------------------

function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

function originPattern(origin: string): string {
  return `${new URL(origin).origin}/*`;
}

function safePageUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    return isAllowedOrigin(url.origin) ? `${url.origin}${url.pathname}` : null;
  } catch {
    return null;
  }
}

function allowedPageUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    if (url.username || url.password || [...url.searchParams.keys()].some((key) => /(password|passwd|secret|token|cookie|authorization|credential|api[-_]?key)/i.test(key))) return null;
    return isAllowedOrigin(url.origin) ? url.toString() : null;
  } catch {
    return null;
  }
}

function currentPage(): PresentationPage | null {
  if (!machine) return null;
  return machine.project.pages[machine.session.currentPageIndex] ?? null;
}

function currentConnector(page: PresentationPage | null): PresentationConnector | null {
  if (!machine || !page) return null;
  return machine.project.connectors.find((connector) => connector.id === page.connectorId) ?? null;
}

function connectorForPage(project: Project, page: PresentationPage | null): PresentationConnector | null {
  if (!page) return null;
  return project.connectors.find((connector) => connector.id === page.connectorId) ?? null;
}

function offlineActive(): boolean {
  if (!machine) return false;
  const page = currentPage();
  return Boolean(page && machine.session.offlineFallbackPageId === page.id);
}

function stageUrl(): string {
  return `${browser.runtime.getURL("/stage.html")}?session=${machine?.session.id ?? ""}`;
}

function targetUrlForPage(page: PresentationPage | null): string {
  if (!machine || !page) return stageUrl();
  if (offlineActive() || page.pageType === "fixed" || page.pageType === "end" || !page.url) return stageUrl();
  const resolved = resolveUrlTemplate(page.url, machine.project, page);
  if (resolved.ok) return resolved.value;
  const fallback = page.fallbackUrl ? resolveUrlTemplate(page.fallbackUrl, machine.project, page) : null;
  return fallback?.ok ? fallback.value : stageUrl();
}

function businessReady(): boolean {
  if (!machine) return false;
  const page = currentPage();
  if (!page) return false;
  if (offlineActive()) return isOfflineFallbackReady(page.offline);
  if (page.pageType === "fixed" || page.pageType === "end" || !page.url) return true;
  if (runtime.tabKind !== "business" || runtime.tabStatus !== "complete") return false;
  return (runtime.connectorState?.state ?? "ready") === "ready";
}

function missingSecrets(): string[] {
  if (!machine) return [];
  return missingRuntimeSecrets(machine.session.id, machine.project.sensitiveVariables).map((variable) => variable.key);
}

function broadcastMeta(): BroadcastMeta {
  return {
    running: machine !== null,
    live: runtime.sessionTabId !== null,
    sessionTabId: runtime.sessionTabId,
    tabKind: runtime.tabKind,
    tabStatus: runtime.tabStatus,
    tabUnsafeOrigin: runtime.tabUnsafeOrigin,
    businessReady: businessReady(),
    connectorState: runtime.connectorState,
    stepExecution: runtime.stepExecution,
    missingSecrets: missingSecrets(),
    recorderActive: recorder !== null,
    captureActive,
    viewerCount: [...viewers.values()].filter((viewer) => viewer.status === "connected").length,
    offlineOriginRequest: runtime.offlineOriginRequest,
    message: runtime.message
  };
}

function broadcastState(): void {
  if (!machine) return;
  const state: BroadcastState = { machine, meta: broadcastMeta() };
  postToAll({ type: "state", state });
  void syncOverlay();
  scheduleSnapshot();
}

function postToAll(message: BgMessage): void {
  for (const entry of uiPorts) {
    try {
      entry.port.postMessage(message);
    } catch {
      uiPorts.delete(entry);
    }
  }
}

function postToContext(ctx: string, message: BgMessage): void {
  for (const entry of uiPorts) {
    if (entry.ctx !== ctx) continue;
    try {
      entry.port.postMessage(message);
    } catch {
      uiPorts.delete(entry);
    }
  }
}

function scheduleSnapshot(): void {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    if (machine) void kvSessionSet(MACHINE_SNAPSHOT_KEY, { machine }).catch(() => undefined);
  }, 250);
}

function applyMachineAction(action: SessionAction): void {
  if (!machine) return;
  const before = machine.session.currentPageIndex;
  const beforeOffline = offlineActive();
  const beforeProjectId = machine.project.id;
  const result = applyAction(machine, action);
  machine = result.state;
  if (result.rehearsal) void saveRehearsal(result.rehearsal).catch((error) => recordDiagnostic("保存排练记录", error));
  const changedPage = machine.session.currentPageIndex !== before || beforeOffline !== offlineActive() || machine.project.id !== beforeProjectId;
  broadcastState();
  if (changedPage) {
    runtime.connectorState = null;
    void syncSessionTab(true).then(() => {
      resolveBoundMasks();
      broadcastState();
    });
  }
}

// ---- overlay sync (business tab) ----------------------------------------------

function overlayStateFor(page: PresentationPage): OverlayState {
  const project = machine!.project;
  return {
    sessionId: machine!.session.id,
    pageId: page.id,
    screenMode: machine!.session.screenMode,
    annotationTool: machine!.session.annotationTool,
    circles: machine!.session.circles,
    privacyMasks: page.privacyMasks.map((mask) => ({ id: mask.id, x1: mask.x1, y1: mask.y1, x2: mask.x2, y2: mask.y2, mode: mask.mode })),
    offlineActive: offlineActive(),
    brand: { primaryColor: project.brand.primaryColor, privacyMessage: project.brand.privacyMessage }
  };
}

async function syncOverlay(): Promise<void> {
  if (!machine || runtime.sessionTabId === null || runtime.tabKind !== "business") return;
  const page = currentPage();
  if (!page) return;
  try {
    await browser.tabs.sendMessage(runtime.sessionTabId, { type: "showit-overlay", overlay: overlayStateFor(page) });
  } catch {
    // The content script is not injected yet; onUpdated complete handles it.
  }
}

async function ensureContentScript(tabId: number): Promise<boolean> {
  try {
    await browser.tabs.sendMessage(tabId, { type: "showit-probe" });
    return true;
  } catch {
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
      return true;
    } catch (error) {
      recordDiagnostic("注入业务页连接器", error);
      return false;
    }
  }
}

async function resolveBoundMasks(): Promise<void> {
  if (!machine || runtime.sessionTabId === null || runtime.tabKind !== "business") return;
  const page = currentPage();
  if (!page) return;
  const bound = page.privacyMasks.filter((mask) => mask.locator).slice(0, 30);
  if (bound.length === 0) return;
  try {
    const result = await browser.tabs.sendMessage(runtime.sessionTabId, {
      type: "showit-resolve-privacy-masks",
      items: bound.map((mask) => ({ id: mask.id, locator: mask.locator as unknown as Record<string, unknown> }))
    }) as { ok: boolean; resolved: Array<{ id: string; bounds: { x1: number; y1: number; x2: number; y2: number } }> };
    if (!result?.ok) return;
    for (const item of result.resolved) {
      applyMachineAction({ type: "update-privacy-mask", maskId: item.id, bounds: item.bounds });
    }
  } catch {
    // Bound masks are best-effort; static masks still render.
  }
}

function scheduleBoundMaskResolve(): void {
  if (boundMaskResolveTimer) return;
  boundMaskResolveTimer = setTimeout(() => {
    boundMaskResolveTimer = null;
    void resolveBoundMasks();
  }, 600);
}

// ---- session tab lifecycle ------------------------------------------------------

async function openSessionWindow(targetUrl: string): Promise<void> {
  const dedicated = machine?.session.browserSessionMode === "dedicated";
  let incognito = false;
  if (dedicated) {
    try {
      incognito = await browser.extension.isAllowedIncognitoAccess();
    } catch {
      incognito = false;
    }
    if (dedicated && !incognito) runtime.message = "专用演示环境需要在浏览器扩展设置中允许 Showit 进入无痕窗口，已使用普通窗口。";
  }
  const created = await browser.windows.create({ url: targetUrl, focused: true, width: 1280, height: 832, incognito });
  runtime.sessionWindowId = created?.id ?? null;
  const tab = created?.tabs?.[0];
  runtime.sessionTabId = tab?.id ?? null;
  runtime.tabKind = targetUrl === stageUrl() ? "stage" : "business";
  runtime.tabStatus = "loading";
  runtime.tabUnsafeOrigin = false;
}

async function syncSessionTab(force = false): Promise<void> {
  if (!machine || runtime.sessionTabId === null) return;
  const target = targetUrlForPage(currentPage());
  const wantKind = target === stageUrl() ? "stage" : "business";
  let currentUrl: string | undefined;
  try {
    const tab = await browser.tabs.get(runtime.sessionTabId);
    currentUrl = tab.url;
  } catch {
    return;
  }
  const sameBusiness = wantKind === "business" && runtime.tabKind === "business" && currentUrl === target;
  if (!force && sameBusiness) return;
  if (wantKind === "stage" && runtime.tabKind === "stage" && currentUrl?.startsWith(stageUrl())) return;
  runtime.tabKind = wantKind;
  runtime.tabStatus = "loading";
  runtime.connectorState = null;
  runtime.tabUnsafeOrigin = false;
  await browser.tabs.update(runtime.sessionTabId, { url: target }).catch((error) => recordDiagnostic("导航演示标签", error));
}

async function probeSessionTab(): Promise<void> {
  if (!machine || runtime.sessionTabId === null || runtime.tabKind !== "business") return;
  const page = currentPage();
  if (!page) return;
  const connector = connectorForPage(machine.project, page);
  const injected = await ensureContentScript(runtime.sessionTabId);
  if (!injected) {
    runtime.connectorState = { state: "error", reason: "业务页连接器无法注入，请检查站点授权。" };
    broadcastState();
    return;
  }
  try {
    const probe = await browser.tabs.sendMessage(runtime.sessionTabId, { type: "showit-probe" }) as { origin: string; title: string; hasPasswordField: boolean; privacyRisk: string | null };
    const expectedOrigin = connector ? new URL(connector.origin).origin : null;
    if (expectedOrigin && probe.origin !== expectedOrigin) {
      runtime.connectorState = { state: "blocked", reason: "业务页与连接器 Origin 不匹配。" };
      broadcastState();
      return;
    }
    if (probe.privacyRisk === "file") {
      runtime.connectorState = { state: "blocked", reason: "业务页包含文件上传等敏感输入。" };
      broadcastState();
      return;
    }
    if (probe.privacyRisk || probe.hasPasswordField) {
      runtime.connectorState = { state: "blocked", reason: "业务页包含登录或敏感输入，观众画面已保护。" };
      broadcastState();
      return;
    }
    if (connector?.sessionProbe) {
      runtime.connectorState = { state: "ready" };
      broadcastState();
      const result = await browser.tabs.sendMessage(runtime.sessionTabId, {
        type: "showit-session-probe",
        sessionId: machine.session.id,
        connector: connector as unknown as Record<string, unknown>,
        role: page.role
      }).catch(() => null) as { state: string; role?: string; reason?: string } | null;
      if (result && ["ready", "anonymous", "role-mismatch", "error"].includes(result.state)) {
        runtime.connectorState = { state: result.state as ConnectorRuntimeState["state"], role: result.role, reason: result.reason };
        broadcastState();
      }
      return;
    }
    runtime.connectorState = { state: "ready" };
    broadcastState();
  } catch (error) {
    recordDiagnostic("探测业务页", error);
    runtime.connectorState = { state: "error", reason: "业务页探测失败。" };
    broadcastState();
  }
}

async function handleTabUpdated(tabId: number, changeInfo: Browser.tabs.OnUpdatedInfo, tab: Browser.tabs.Tab): Promise<void> {
  if (runtime.sessionTabId === tabId) {
    if (changeInfo.status === "complete") {
      runtime.tabStatus = "complete";
      const url = safePageUrl(tab.url ?? "");
      const expected = targetUrlForPage(currentPage());
      const expectedOrigin = expected === stageUrl() ? null : new URL(expected).origin;
      runtime.tabUnsafeOrigin = Boolean(url && expectedOrigin && new URL(url).origin !== expectedOrigin && !isDescendantOrigin(new URL(url).origin, expectedOrigin));
      if (runtime.tabKind === "business") {
        await syncOverlay();
        await probeSessionTab();
      } else {
        runtime.connectorState = null;
      }
      broadcastState();
    } else if (changeInfo.status === "loading") {
      runtime.tabStatus = "loading";
      broadcastState();
    }
    return;
  }
  if (!recorder || recorder.tabId !== tabId || changeInfo.status !== "complete") return;
  const url = safePageUrl(tab.url ?? "");
  if (!url || url === recorder.lastUrl) return;
  recorder.lastUrl = url;
  postToContext("workbench", { type: "recorded-action", recordingId: recorder.recordingId, action: { type: "navigate", url } satisfies RecordedAction });
  void browser.tabs.sendMessage(tabId, { type: "showit-recorder-start", recordingId: recorder.recordingId }).catch(() => undefined);
}

function isDescendantOrigin(candidate: string, base: string): boolean {
  return candidate === base;
}

export default defineBackground(() => {
  self.addEventListener("unhandledrejection", (event) => recordDiagnostic("未处理 Promise", (event as PromiseRejectionEvent).reason));
  browser.tabs.onUpdated.addListener((tabId: number, changeInfo: Browser.tabs.OnUpdatedInfo, tab: Browser.tabs.Tab) => {
    void handleTabUpdated(tabId, changeInfo, tab);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    if (runtime.sessionTabId === tabId) {
      runtime.sessionTabId = null;
      runtime.sessionWindowId = null;
      runtime.tabKind = null;
      runtime.tabStatus = null;
      runtime.connectorState = null;
      runtime.message = "演示画面标签已关闭，可从控制台恢复。";
      void stopCapture();
      broadcastState();
    }
  });

  // ---- DNR protection ---------------------------------------------------------------

  async function currentProtectionRuleIds(): Promise<number[]> {
    const rules = await browser.declarativeNetRequest.getDynamicRules();
    return rules.map((rule) => rule.id).filter((id) => id >= PROTECTION_RULE_ID_MIN && id < PROTECTION_RULE_ID_MAX);
  }

  async function applyProtectionRules(): Promise<void> {
    const removeRuleIds = await currentProtectionRuleIds();
    if (!machine) {
      await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds }).catch(() => undefined);
      return;
    }
    const addRules = [];
    for (const connector of machine.project.connectors) {
      if (connector.securityMode !== "request-protection" && connector.securityMode !== "readonly-proxy") continue;
      const origins = [...new Set([connector.origin, ...connector.allowedOrigins])].filter(isAllowedOrigin).map((origin) => new URL(origin).origin);
      const allowedPaths = connector.securityMode === "request-protection"
        ? sanitizeProtectionPaths([...connector.loginPaths, ...connector.logoutPaths, ...connector.roleSwitchPaths])
        : [];
      addRules.push(...buildProtectionRules(origins, allowedPaths));
    }
    await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: addRules as never }).catch((error) => recordDiagnostic("配置请求保护", error));
  }

  async function clearProtectionRules(): Promise<void> {
    const removeRuleIds = await currentProtectionRuleIds();
    if (removeRuleIds.length > 0) await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds }).catch(() => undefined);
  }

  // ---- step execution ----------------------------------------------------------------

  function capExecution(execution: string, connector: PresentationConnector | null): "hint" | "highlight" | "assist" | "auto" {
    const level = isValidStepExecution(execution) ? execution : "hint";
    if (!connector) return level;
    if (connector.permission === "observe") return level === "hint" ? "hint" : "highlight";
    if (connector.permission === "assist" && level === "auto") return "assist";
    return level;
  }

  async function waitForCondition(tabId: number, condition: Record<string, unknown>, timeoutSeconds: number): Promise<{ ok: boolean; reason?: string }> {
    const deadline = Date.now() + Math.min(30, Math.max(1, Number(timeoutSeconds) || 8)) * 1000;
    while (Date.now() < deadline) {
      try {
        const result = await browser.tabs.sendMessage(tabId, { type: "showit-check-condition", condition }) as { ok: boolean };
        if (result?.ok) return { ok: true };
      } catch {
        // Navigation temporarily detaches the content script; retry until timeout.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ok: false, reason: "预期条件超时" };
  }

  async function runStepExecution(stepId: string): Promise<void> {
    if (!machine || runtime.sessionTabId === null) return;
    const page = currentPage();
    if (!page) return;
    const step = page.script.steps.find((item) => item.id === stepId);
    if (!step?.recordedAction || !isValidExecutionAction(step.recordedAction as unknown as Record<string, unknown>)) return;
    const connector = connectorForPage(machine.project, page);
    const execution = capExecution(step.execution, connector);
    if (execution === "hint") {
      applyMachineAction({ type: "complete-step", stepId });
      return;
    }
    let action: Record<string, unknown>;
    try {
      action = resolveRecordedAction(step.recordedAction, machine.project, page, machine.session.id) as unknown as Record<string, unknown>;
    } catch {
      runtime.message = "步骤缺少敏感变量，请在控制台填写后重试。";
      broadcastState();
      return;
    }
    const sensitiveFill = step.recordedAction.type === "fill" && step.recordedAction.input.source === "sensitive";
    const previousScreenMode = machine.session.screenMode;
    if (sensitiveFill && previousScreenMode === "normal") applyMachineAction({ type: "set-screen-mode", screenMode: "privacy" });

    runtime.stepExecution = { stepId, state: "running" };
    broadcastState();
    let result: { ok: boolean; performed?: string | undefined; reason?: string | undefined };
    try {
      if (action.type === "navigate") {
        const url = allowedPageUrl(action.url as string);
        if (!url || execution !== "auto") {
          result = { ok: execution !== "auto", performed: "highlight", reason: execution === "auto" ? "导航 URL 无效" : undefined };
        } else {
          await browser.tabs.update(runtime.sessionTabId, { url });
          result = { ok: true, performed: "navigate" };
        }
      } else {
        result = await browser.tabs.sendMessage(runtime.sessionTabId, { type: "showit-execute-action", action, execution }) as { ok: boolean; performed?: string; reason?: string };
      }
    } catch (error) {
      recordDiagnostic("执行录制步骤", error);
      result = { ok: false, reason: error instanceof Error ? error.message : "步骤执行失败。" };
    }

    if (!result?.ok) {
      runtime.stepExecution = { stepId, state: "failed", reason: String(result?.reason || "动作执行失败").slice(0, 200) };
      broadcastState();
      return;
    }

    if (step.expectedCondition && isValidExpectedCondition(step.expectedCondition as unknown as Record<string, unknown>)) {
      const condition = await waitForCondition(runtime.sessionTabId, step.expectedCondition as unknown as Record<string, unknown>, step.conditionTimeoutSeconds);
      if (!condition.ok) {
        runtime.stepExecution = { stepId, state: "failed", reason: condition.reason };
        broadcastState();
        return;
      }
      runtime.stepExecution = null;
      applyMachineAction({ type: "complete-step", stepId });
      if (sensitiveFill && machine?.session.screenMode === "privacy" && previousScreenMode === "normal") applyMachineAction({ type: "set-screen-mode", screenMode: "normal" });
      if (canAutoContinueAfterVerification(page, step) && machine) {
        const completed = machine.session.completedStepIds;
        const next = page.script.steps.find((item) => item.id !== stepId && !completed.includes(item.id));
        if (next?.recordedAction && next.execution !== "hint" && next.risk !== "high") {
          setTimeout(() => void runStepExecution(next.id), 0);
        }
      }
      return;
    }

    runtime.stepExecution = { stepId, state: "manual" };
    broadcastState();
    if (sensitiveFill && machine.session.screenMode === "privacy" && previousScreenMode === "normal") applyMachineAction({ type: "set-screen-mode", screenMode: "normal" });
  }

  function handleExecuteStep(stepId: string, confirmed = false): void {
    if (!machine) return;
    const page = currentPage();
    if (!page) return;
    const step = page.script.steps.find((item) => item.id === stepId);
    if (!step) return;
    if (step.risk === "high" && !machine.session.completedStepIds.includes(stepId)) {
      if (!confirmed) {
        applyMachineAction({ type: "toggle-step", stepId });
        return;
      }
      applyMachineAction({ type: "confirm-high-risk-step" });
    }
    if (step.recordedAction && step.execution !== "hint") {
      void runStepExecution(stepId);
      return;
    }
    applyMachineAction({ type: "toggle-step", stepId });
  }

  function interceptAction(action: SessionAction): void {
    if (!machine) return;
    if (action.type === "next-step") {
      const page = currentPage();
      const completed = machine.session.completedStepIds;
      const next = page?.script.steps.find((step) => !completed.includes(step.id));
      if (next && next.recordedAction && next.execution !== "hint" && next.risk !== "high") {
        handleExecuteStep(next.id);
        return;
      }
    }
    if (action.type === "complete-step") {
      const page = currentPage();
      const step = page?.script.steps.find((item) => item.id === action.stepId);
      if (step?.recordedAction && step.execution !== "hint" && !machine.session.completedStepIds.includes(action.stepId) && runtime.stepExecution?.stepId !== action.stepId) {
        handleExecuteStep(action.stepId);
        return;
      }
    }
    applyMachineAction(action);
  }

  // ---- auto-advance ----------------------------------------------------------------

  function evaluateAutoAdvance(uiBlocked: boolean): void {
    if (!machine || runtime.sessionTabId === null) return;
    const session = machine.session;
    const page = currentPage();
    if (!page) return;
    const needsBusiness = !offlineActive() && page.pageType !== "fixed" && page.pageType !== "end" && Boolean(page.url);
    const blocked = session.timerStatus !== "running"
      || session.screenMode !== "normal"
      || session.annotationTool !== "none"
      || session.pendingHighRiskStepId !== null
      || runtime.stepExecution !== null
      || runtime.offlineOriginRequest !== null
      || (needsBusiness && !businessReady())
      || uiBlocked;
    const running = session.autoAdvanceStartedAt !== null;
    if (running === blocked) {
      applyMachineAction({ type: "set-auto-advance-running", running: !blocked });
    }
    if (blocked || session.autoAdvanceStartedAt === null) return;
    const thresholdSeconds = page.autoAdvanceSeconds ?? machine.project.autoAdvanceSeconds;
    if (autoAdvanceElapsedMs(session) < thresholdSeconds * 1000) return;
    if (session.currentPageIndex >= machine.project.pages.length - 1) return;
    applyMachineAction({ type: "set-active-page", index: session.currentPageIndex + 1 });
  }

  // ---- audience windows & capture -----------------------------------------------------

  async function ensureOffscreen(): Promise<boolean> {
    if (offscreenReady) return true;
    try {
      await browser.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["USER_MEDIA"] as never,
        justification: "Showit 需要捕获演示标签页画面，经安全合成后投送给本机观众窗口。"
      });
      offscreenReady = true;
      return true;
    } catch (error) {
      recordDiagnostic("创建离屏文档", error);
      return false;
    }
  }

  async function closeOffscreen(): Promise<void> {
    if (!offscreenReady) return;
    offscreenReady = false;
    try {
      await browser.offscreen.closeDocument();
    } catch {
      // Already gone.
    }
  }

  function postToOffscreen(message: BgMessage): void {
    postToContext("offscreen", message);
  }

  async function startCapture(): Promise<void> {
    if (!machine || runtime.sessionTabId === null || captureActive) return;
    if (!await ensureOffscreen()) {
      runtime.message = "观众画面离屏文档不可用。";
      broadcastState();
      return;
    }
    try {
      const streamId = await browser.tabCapture.getMediaStreamId({ targetTabId: runtime.sessionTabId } as never);
      postToOffscreen({ type: "capture-start", streamId: String(streamId), tabId: runtime.sessionTabId });
    } catch (error) {
      recordDiagnostic("捕获演示标签", error);
      runtime.message = "画面捕获需要授权：请在演示画面标签上点击浏览器工具栏的 Showit 图标、右键选择“Showit：授权画面捕获”，或按 Ctrl+Shift+9。";
      broadcastState();
    }
  }

  async function stopCapture(): Promise<void> {
    if (!captureActive) return;
    captureActive = false;
    postToOffscreen({ type: "capture-stop" });
    await closeOffscreen();
  }

  function openAudienceWindow(): void {
    if (!machine) return;
    const viewerId = `viewer-${Math.random().toString(36).slice(2, 10)}`;
    const url = `${browser.runtime.getURL("/audience.html")}?viewer=${viewerId}`;
    void browser.windows.create({ url, type: "popup", width: 1280, height: 800, focused: false }).then((created) => {
      if (created?.id !== undefined) audienceWindows.set(viewerId, created.id);
    }).catch((error) => {
      recordDiagnostic("打开观众窗口", error);
      runtime.message = "观众窗口打开失败。";
      broadcastState();
    });
  }

  /** tabCapture requires the extension to be invoked on the session tab
   *  (toolbar icon click or context menu — both grant activeTab). */
  async function authorizeCapture(): Promise<void> {
    if (!machine || captureActive) return;
    runtime.message = "授权请求已收到，正在捕获画面…";
    broadcastState();
    await startCapture();
    if (captureActive) runtime.message = null;
    broadcastState();
  }

  function registerViewer(viewerId: string): void {
    if (viewers.has(viewerId)) return;
    viewers.set(viewerId, { viewerId, status: "connecting" });
    void (async () => {
      await startCapture();
      if (captureActive || runtime.sessionTabId !== null) postToOffscreen({ type: "viewer-added", viewerId });
      broadcastState();
    })();
  }

  function removeViewer(viewerId: string): void {
    if (!viewers.delete(viewerId)) return;
    postToOffscreen({ type: "viewer-removed", viewerId });
    const connected = [...viewers.values()].filter((viewer) => viewer.status === "connected").length;
    if (connected === 0) {
      applyMachineAction({ type: "local-audience-closed" });
      void stopCapture();
    } else {
      applyMachineAction({ type: "set-audience-count", count: connected });
    }
    broadcastState();
  }

  function relaySignal(message: { to: string; from: string; data: unknown }): void {
    if (message.to === "publisher") {
      postToOffscreen({ type: "rtc-signal", to: message.to, from: message.from, data: message.data });
      return;
    }
    for (const entry of uiPorts) {
      if (entry.ctx !== "audience" || entry.viewerId !== message.to) continue;
      try {
        entry.port.postMessage({ type: "rtc-signal", to: message.to, from: message.from, data: message.data });
      } catch {
        uiPorts.delete(entry);
      }
    }
  }

  // ---- recorder -----------------------------------------------------------------------

  async function startRecorder(recordingId: string): Promise<void> {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !safePageUrl(tab.url ?? "")) {
      postToContext("workbench", { type: "recorder-state", active: false, reason: "未找到已授权的活动业务标签。" });
      return;
    }
    const origin = new URL(safePageUrl(tab.url ?? "")!).origin;
    let granted = false;
    try {
      granted = await browser.permissions.contains({ origins: [originPattern(origin)] });
    } catch {
      granted = false;
    }
    if (!granted) {
      postToContext("workbench", { type: "recorder-state", active: false, reason: `需要先授权 ${origin}`, origin });
      return;
    }
    if (!await ensureContentScript(tab.id)) {
      postToContext("workbench", { type: "recorder-state", active: false, reason: "业务页连接器无法注入。" });
      return;
    }
    const result = await browser.tabs.sendMessage(tab.id, { type: "showit-recorder-start", recordingId }).catch(() => null) as { ok: boolean; title?: string } | null;
    if (!result?.ok) {
      postToContext("workbench", { type: "recorder-state", active: false, reason: "业务标签未加载 Showit 连接器。" });
      return;
    }
    recorder = { recordingId, tabId: tab.id, lastUrl: safePageUrl(tab.url ?? "")! };
    postToContext("workbench", { type: "recorder-state", active: true, pageTitle: String(result.title || "").slice(0, 160) });
    broadcastState();
  }

  async function stopRecorder(): Promise<void> {
    const current = recorder;
    recorder = null;
    if (current?.tabId) await browser.tabs.sendMessage(current.tabId, { type: "showit-recorder-stop" }).catch(() => undefined);
    postToContext("workbench", { type: "recorder-state", active: false });
    broadcastState();
  }

  // ---- session lifecycle ----------------------------------------------------------------

  async function beginSession(projectId: string, port?: Browser.runtime.Port): Promise<void> {
    const workspace = await loadWorkspace(projectId);
    if (!workspace || workspace.project.id !== projectId) {
      port?.postMessage({ type: "error", message: "没有找到该本地项目。" });
      return;
    }
    if (await projectTrustState(workspace.project) !== "trusted") {
      port?.postMessage({ type: "error", message: "项目尚未信任或内容已变化，请先在项目库确认信任。" });
      return;
    }
    const launch = beginPresentationLaunch(workspace.project, workspace.session);
    machine = applyAction(initialMachineState(), { type: "set-workspace", project: launch.project, session: launch.session }).state;
    runtime.sessionWindowId = null;
    runtime.sessionTabId = null;
    runtime.connectorState = null;
    runtime.stepExecution = null;
    runtime.offlineOriginRequest = null;
    runtime.message = null;
    await applyProtectionRules();
    await openSessionWindow(targetUrlForPage(currentPage()));
    broadcastState();
  }

  async function resumeSession(): Promise<void> {
    if (!machine) return;
    if (runtime.sessionTabId === null) {
      await openSessionWindow(targetUrlForPage(currentPage()));
    } else {
      await syncSessionTab(true);
    }
    await applyProtectionRules();
    runtime.message = null;
    broadcastState();
  }

  async function endSession(): Promise<void> {
    if (!machine) return;
    applyMachineAction({ type: "end-presentation" });
    const finalMachine = machine;
    const { presenterEdits } = finalMachine;
    const runtimeProject = finalMachine.project;
    const runtimeSession = finalMachine.session;
    machine = null;
    await stopRecorder();
    for (const viewerId of [...viewers.keys()]) {
      const entry = [...uiPorts].find((item) => item.ctx === "audience" && item.viewerId === viewerId);
      if (entry) {
        try {
          entry.port.disconnect();
        } catch {
          // Already disconnected.
        }
        uiPorts.delete(entry);
      }
    }
    for (const audienceWindowId of audienceWindows.values()) {
      await browser.windows.remove(audienceWindowId).catch(() => undefined);
    }
    audienceWindows.clear();
    viewers = new Map();
    await stopCapture();
    await closeOffscreen();
    await clearProtectionRules();
    clearRuntimeSecrets(runtimeSession.id);
    await kvSessionRemove(MACHINE_SNAPSHOT_KEY);
    const windowId = runtime.sessionWindowId;
    runtime.sessionWindowId = null;
    runtime.sessionTabId = null;
    runtime.tabKind = null;
    runtime.tabStatus = null;
    runtime.connectorState = null;
    runtime.stepExecution = null;
    runtime.offlineOriginRequest = null;
    runtime.message = null;
    if (windowId !== null) await browser.windows.remove(windowId).catch(() => undefined);
    try {
      await mergePresenterEditsIntoWorkspace(runtimeProject, presenterEdits);
      const stored = await loadWorkspace(runtimeProject.id);
      if (stored && stored.project.id === runtimeProject.id && runtimeSession.projectId === stored.project.id) {
        await saveWorkspace({ ...stored, session: runtimeSession });
      }
    } catch (error) {
      recordDiagnostic("退出演示保存", error);
    }
    postToAll({ type: "state", state: { machine: finalMachine, meta: broadcastMeta() } });
  }

  // ---- ports ----------------------------------------------------------------------------

  browser.runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith(PORT_PREFIX)) return;
    const entry: UiPort = { ctx: port.name.slice(PORT_PREFIX.length), port };
    uiPorts.add(entry);
    port.onDisconnect.addListener(() => {
      uiPorts.delete(entry);
      if (entry.ctx === "audience" && entry.viewerId) removeViewer(entry.viewerId);
      if (entry.ctx === "sidepanel" && machine) broadcastState();
    });
    port.onMessage.addListener((message: UiMessage) => {
      void handleUiMessage(message, entry, port);
    });
    if (machine) {
      try {
        port.postMessage({ type: "state", state: { machine, meta: broadcastMeta() } });
      } catch {
        // Port closed before the first state write.
      }
    }
  });

  async function handleUiMessage(message: UiMessage, entry: UiPort, port: Browser.runtime.Port): Promise<void> {
    switch (message.type) {
      case "hello":
        if (entry.ctx === "audience" && message.viewerId) {
          entry.viewerId = message.viewerId;
          registerViewer(message.viewerId);
        }
        if (machine) {
          try {
            port.postMessage({ type: "state", state: { machine, meta: broadcastMeta() } });
          } catch {
            // ignore
          }
        }
        return;
      case "action":
        interceptAction(message.action);
        return;
      case "tick":
        evaluateAutoAdvance(Boolean(message.uiBlocked));
        return;
      case "begin":
        await beginSession(message.projectId, port);
        return;
      case "resume":
        await resumeSession();
        return;
      case "end-session":
        await endSession();
        return;
      case "secrets":
        if (machine) {
          setRuntimeSecrets(machine.session.id, machine.project.sensitiveVariables, message.values);
          broadcastState();
        }
        return;
      case "execute-step":
        handleExecuteStep(message.stepId, message.confirmed === true);
        return;
      case "pick-mask": {
        if (!machine || runtime.sessionTabId === null || runtime.tabKind !== "business") {
          port.postMessage({ type: "error", message: "只有业务页面可以框选遮罩。" });
          return;
        }
        try {
          const result = await browser.tabs.sendMessage(runtime.sessionTabId, { type: "showit-pick-privacy-mask" }) as { ok: boolean; locator?: Record<string, unknown>; bounds?: Record<string, number>; reason?: string };
          if (result?.ok && result.locator && result.bounds) {
            applyMachineAction({
              type: "add-privacy-mask",
              mask: {
                id: `mask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                x1: result.bounds.x1!,
                y1: result.bounds.y1!,
                x2: result.bounds.x2!,
                y2: result.bounds.y2!,
                mode: "blur",
                locator: result.locator as never
              }
            });
          } else {
            runtime.message = result?.reason ?? "遮罩选择已取消。";
            broadcastState();
          }
        } catch (error) {
          recordDiagnostic("选择隐私遮罩", error);
        }
        return;
      }
      case "cancel-mask-pick":
        if (runtime.sessionTabId !== null) await browser.tabs.sendMessage(runtime.sessionTabId, { type: "showit-cancel-privacy-mask" }).catch(() => undefined);
        return;
      case "open-audience":
        openAudienceWindow();
        return;
      case "open-workbench":
        await browser.tabs.create({ url: browser.runtime.getURL("/workbench.html") }).catch((error) => recordDiagnostic("打开工作台", error));
        return;
      case "recorder-start":
        await startRecorder(message.recordingId);
        return;
      case "recorder-stop":
        await stopRecorder();
        return;
      case "rtc-signal":
        relaySignal(message);
        return;
      case "viewer-status":
        if (viewers.has(message.viewerId)) {
          viewers.set(message.viewerId, { viewerId: message.viewerId, status: message.status === "connected" ? "connected" : message.status === "failed" ? "failed" : "connecting" });
          if (message.status === "connected") {
            applyMachineAction({ type: "audience-ready" });
          } else if (message.status === "failed") {
            runtime.message = "一个观众窗口连接失败。";
          }
          const connected = [...viewers.values()].filter((viewer) => viewer.status === "connected").length;
          applyMachineAction({ type: "set-audience-count", count: connected });
        }
        return;
      case "capture-state":
        captureActive = message.active === true;
        if (!captureActive && viewers.size === 0) await closeOffscreen();
        if (message.error) {
          runtime.message = String(message.error).slice(0, 200);
          broadcastState();
        }
        return;
      case "stage-offline-origin-request":
        if (machine && !runtime.offlineOriginRequest) {
          runtime.offlineOriginRequest = message.origin;
          broadcastState();
        }
        return;
      default:
        return;
    }
  }

  // ---- content script upstream messages ------------------------------------------------

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const typed = message as { type?: string } | null;
    if (!typed?.type) return false;
    if (typed.type === "showit-resource-failures") {
      const payload = typed as unknown as { origin: string; count: number };
      const isSessionTab = sender.tab?.id === runtime.sessionTabId;
      if (!machine || !isSessionTab || !isAllowedOrigin(payload.origin)) return false;
      runtime.connectorState = { state: "error", reason: `业务页资源加载失败 ${Math.min(10_000, Math.max(0, payload.count))} 次。` };
      broadcastState();
      sendResponse({ accepted: true });
      return false;
    }
    if (typed.type === "showit-privacy-risk") {
      const payload = typed as unknown as { origin: string; privacyRisk: string };
      const isSessionTab = sender.tab?.id === runtime.sessionTabId;
      if (!machine || !isSessionTab || !isAllowedOrigin(payload.origin)) return false;
      if (payload.privacyRisk === "file") {
        runtime.connectorState = { state: "blocked", reason: "业务页包含文件上传等敏感输入。" };
      } else {
        runtime.connectorState = { state: "anonymous", reason: "业务页包含登录或敏感输入。" };
      }
      broadcastState();
      return false;
    }
    if (typed.type === "showit-recorded-action") {
      const payload = typed as unknown as { recordingId: string; action: RecordedAction };
      if (!recorder || sender.tab?.id !== recorder.tabId || payload.recordingId !== recorder.recordingId || !isValidRecordedAction(payload.action)) return false;
      postToContext("workbench", { type: "recorded-action", recordingId: recorder.recordingId, action: payload.action });
      sendResponse({ accepted: true });
      return false;
    }
    if (typed.type === "showit-circle-added") {
      const payload = typed as unknown as { sessionId: string; circle: { id: string; x1: number; y1: number; x2: number; y2: number } };
      if (!machine || payload.sessionId !== machine.session.id || sender.tab?.id !== runtime.sessionTabId) return false;
      const circle = payload.circle;
      if (!circle || typeof circle.id !== "string" || circle.id.length === 0 || circle.id.length > 120) return false;
      if ([circle.x1, circle.y1, circle.x2, circle.y2].some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) return false;
      applyMachineAction({
        type: "add-circle",
        circle: { id: circle.id, x1: circle.x1, y1: circle.y1, x2: circle.x2, y2: circle.y2 }
      });
      return false;
    }
    if (typed.type === "business-page-message") {
      const payload = typed as unknown as { origin: string; title: string; payload: { state: string; role?: string } };
      if (!machine || sender.tab?.id !== runtime.sessionTabId || !isAllowedOrigin(payload.origin)) return false;
      const state = ["ready", "anonymous", "role-mismatch", "loading", "error", "blocked"].includes(payload.payload?.state) ? payload.payload.state : "loading";
      runtime.connectorState = { state: state as ConnectorRuntimeState["state"], ...(payload.payload?.role ? { role: payload.payload.role } : {}) };
      broadcastState();
      sendResponse({ accepted: true });
      return false;
    }
    if (typed.type === "showit-session-probe-result") {
      const payload = typed as unknown as { sessionId: string; state: string; role?: string; reason?: string };
      if (!machine || payload.sessionId !== machine.session.id || sender.tab?.id !== runtime.sessionTabId) return false;
      if (["ready", "anonymous", "role-mismatch", "error"].includes(payload.state)) {
        runtime.connectorState = { state: payload.state as ConnectorRuntimeState["state"], ...(payload.role ? { role: payload.role } : {}), ...(payload.reason ? { reason: payload.reason } : {}) };
        broadcastState();
      }
      return false;
    }
    return false;
  });

  // ---- boot -----------------------------------------------------------------------------

  browser.runtime.onInstalled.addListener(() => {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
    void browser.contextMenus.removeAll().then(() => browser.contextMenus.create({
      id: AUTHORIZE_CAPTURE_MENU_ID,
      title: "Showit：授权画面捕获",
      contexts: ["page"]
    })).catch(() => undefined);
  });

  browser.action.onClicked.addListener(() => {
    void authorizeCapture();
  });

  browser.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === AUTHORIZE_CAPTURE_MENU_ID) void authorizeCapture();
  });

  browser.commands.onCommand.addListener((command) => {
    if (command === "authorize-capture") void authorizeCapture();
  });

  void (async () => {
    try {
      const snapshot = await kvSessionGet<{ machine: MachineState }>(MACHINE_SNAPSHOT_KEY);
      if (snapshot?.machine) {
        machine = snapshot.machine;
        // The session window and tab cannot survive a service worker restart;
        // the presenter restores them from the side panel.
        runtime.message = "演示会话已恢复，请从控制台重新连接画面标签。";
        broadcastState();
      }
    } catch {
      // No snapshot to restore.
    }
  })();


});
