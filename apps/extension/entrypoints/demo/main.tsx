import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { DemoConsole } from "@/lib/demo/DemoConsole";
import { appliedMutations, applyDemoMutation, readDemoSession, writeDemoSession, type DemoMutation, type DemoSession } from "@/lib/demo/data";
import {
  attachAnnotationLayer,
  checkCondition,
  lockPageSelection,
  createOverlayRenderer,
  createRecorder,
  executeAction,
  makeCircleId,
  pickMaskElement,
  resolvePrivacyMasks,
  type Locator
} from "@/lib/dom-connector";
import type { BgMessage, UiMessage } from "@/messaging/protocol";
import { PORT_PREFIX } from "@/messaging/protocol";

/**
 * Built-in demo console ("云枢 · 能力开放平台").
 *
 * Runs in the session tab as chrome-extension://…/demo.html. Because content
 * scripts cannot be injected into extension pages (experiment E1), this page
 * natively implements the connector protocol over chrome.runtime.onMessage —
 * which the background reaches via tabs.sendMessage (experiment E2) — so the
 * existing step-execution, condition, recorder and mask-picking paths work
 * unchanged. Overlay state (covers, masks, circles, laser) arrives on the
 * "showit:demo" port.
 */

let sessionTabId: number | null = null;
void browser.tabs.getCurrent().then((tab) => {
  sessionTabId = tab?.id ?? null;
}).catch(() => undefined);

const overlayRenderer = createOverlayRenderer();
let maskPickerCancel: (() => void) | null = null;
let annotationTool: string = "none";
let annotationLayer: { detach(): void; cancel(): void } | null = null;

const recorder = createRecorder({
  send: (message) => {
    void browser.runtime.sendMessage({ ...message, tabId: sessionTabId ?? undefined }).catch(() => undefined);
  }
});

let activePort: Browser.runtime.Port | null = null;

function post(message: UiMessage): void {
  try {
    activePort?.postMessage(message);
  } catch {
    // Reconnect happens on reload; mutations still apply locally.
  }
}

function reportConnectorState(loggedIn: boolean): void {
  post({ type: "demo-connector-state", state: loggedIn ? "ready" : "anonymous" });
}

function DemoApp() {
  const [, setOverlayTick] = useState(0);
  // 端口重试计数：后台 SW 被回收时用它重新建立连接。
  const [portAttempt, setPortAttempt] = useState(0);
  const sessionRef = useRef<DemoSession | null>(readDemoSession());

  const handleSessionChange = useCallback((session: DemoSession | null) => {
    sessionRef.current = session;
    if (!session) writeDemoSession(null);
    reportConnectorState(Boolean(session));
  }, []);

  const handleMutation = useCallback((mutation?: DemoMutation) => {
    // Replicate to the background so the audience mirror (a separate
    // document with its own module state) sees publish/approve changes.
    if (mutation) post({ type: "demo-mutation", mutation } as UiMessage);
    setOverlayTick((value) => value + 1);
  }, []);

  useEffect(() => {
    const port = browser.runtime.connect({ name: `${PORT_PREFIX}demo` });
    activePort = port;
    port.onMessage.addListener((message: BgMessage) => {
      if (message.type === "state") {
        const machine = message.state.machine;
        // 工具被切走时丢弃拖拽中的草稿。
        if (annotationTool !== machine.session.annotationTool) annotationLayer?.cancel();
        annotationTool = machine.session.annotationTool;
        // 标注期间禁止选中页面元素：划动会被浏览器当成拖选文本。
        lockPageSelection(annotationTool !== "none");
        // Same reasoning as the audience mirror: the mutations live in module
        // state, so nudge a render after replaying them.
        for (const mutation of message.state.meta.demoMutations) applyDemoMutation(mutation as DemoMutation);
        setOverlayTick((value) => value + 1);
        const page = machine.project.pages[machine.session.currentPageIndex];
        overlayRenderer.render({
          screenMode: machine.session.screenMode,
          privacyMessage: machine.project.brand.privacyMessage,
          privacyMasks: page?.privacyMasks ?? [],
          circles: machine.session.circles
        });
      }
    });
    port.onDisconnect.addListener(() => {
      if (activePort === port) activePort = null;
      // 后台 service worker 会在演示中被回收：不重连的话，登录状态与之后每一个
      // 发布/审批都再也传不到后台，观众镜像会一直停在旧状态。
      setTimeout(() => setPortAttempt((value) => value + 1), 500);
    });
    try {
      port.postMessage({ type: "hello", ctx: "demo" } satisfies UiMessage);
      // 补发本页已经发生过的变更，重连窗口期内发生的发布/审批不会丢。
      for (const mutation of appliedMutations) {
        port.postMessage({ type: "demo-mutation", mutation } satisfies UiMessage);
      }
    } catch {
      // 下一次重试会重新连上。
    }
    reportConnectorState(Boolean(sessionRef.current));
    // Navigating to the login view (logout, or a fresh session landing on it)
    // re-opens the login gate after the background already probed the tab —
    // re-report so the console switches back to 未登录.
    const onHashChange = () => reportConnectorState(Boolean(sessionRef.current));
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      if (activePort === port) activePort = null;
      try {
        port.disconnect();
      } catch {
        // Already disconnected.
      }
    };
  }, [portAttempt]);

  // ---- pointer annotations (laser + circle drawing) --------------------------

  useEffect(() => {
    // 与业务页注入脚本共用同一份标注逻辑（激光笔 + 圈选）。
    const layer = attachAnnotationLayer({
      isCircleTool: () => annotationTool === "circle",
      isLaserTool: () => annotationTool === "laser",
      addCircle: (circle) => {
        post({ type: "action", action: { type: "add-circle", circle: { id: makeCircleId(), ...circle } } });
      },
      moveLaser: (point) => {
        post({ type: "stage-laser", laser: { x: point.x, y: point.y, expiresAt: Date.now() + 1500 } });
      }
    }, overlayRenderer);
    annotationLayer = layer;
    return () => {
      annotationLayer = null;
      layer.detach();
    };
  }, []);

  // ---- connector protocol (same handlers as the business-tab content script) --

  useEffect(() => {
    const listener = (message: { type?: string } & Record<string, unknown>, _sender: unknown, sendResponse: (response: unknown) => void) => {
      const view = window.location.hash.replace(/^#\/?/, "") || "login";
      if (message?.type === "showit-probe") {
        const onLogin = view === "login";
        sendResponse({
          origin: location.origin,
          title: document.title,
          hasPasswordField: onLogin,
          privacyRisk: onLogin ? "password" : null
        });
        return false;
      }
      if (message?.type === "showit-recorder-start") {
        recorder.setRecording(message.recordingId as string);
        sendResponse({ ok: recorder.isActive(), url: `${location.origin}/demo.html`, title: document.title });
        return false;
      }
      if (message?.type === "showit-recorder-stop") {
        recorder.setRecording(null);
        sendResponse({ ok: true });
        return false;
      }
      if (message?.type === "showit-execute-action") {
        sendResponse(executeAction(message.action as { type?: string } & Record<string, unknown>, message.execution as string));
        return false;
      }
      if (message?.type === "showit-check-condition") {
        const condition = message.condition as { type?: string } | null | undefined;
        // On the login view a text condition checks the whole document; the
        // login form fields must not make "element" conditions match before
        // the page actually navigated past login (probe keeps parity).
        sendResponse({ ok: checkCondition(condition), url: `${location.origin}/demo.html`, title: document.title });
        return false;
      }
      if (message?.type === "showit-pick-privacy-mask") {
        maskPickerCancel = pickMaskElement(sendResponse, () => maskPickerCancel !== null, (value) => {
          if (!value) maskPickerCancel = null;
        });
        return true;
      }
      if (message?.type === "showit-cancel-privacy-mask") {
        maskPickerCancel?.();
        maskPickerCancel = null;
        sendResponse({ ok: true });
        return false;
      }
      if (message?.type === "showit-resolve-privacy-masks") {
        sendResponse({ ok: true, ...resolvePrivacyMasks(message.items as Array<{ id: string; locator: Locator }>) });
        return false;
      }
      return false;
    };
    browser.runtime.onMessage.addListener(listener as never);
    return () => browser.runtime.onMessage.removeListener(listener as never);
  }, []);

  return <DemoConsole mode="interactive" onSessionChange={handleSessionChange} onMutation={handleMutation} />;
}

const root = document.querySelector("#root");
if (root) createRoot(root).render(<DemoApp />);
