import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { DemoConsole } from "@/lib/demo/DemoConsole";
import { applyDemoMutation, readDemoSession, writeDemoSession, type DemoMutation, type DemoSession } from "@/lib/demo/data";
import {
  checkCondition,
  createOverlayRenderer,
  createRecorder,
  executeAction,
  makeCircleId,
  normalizedPoint,
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
let circleDraft: { startX: number; startY: number; element: HTMLDivElement } | null = null;
let annotationTool: string = "none";

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
        annotationTool = machine.session.annotationTool;
        for (const mutation of message.state.meta.demoMutations) applyDemoMutation(mutation as DemoMutation);
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
    });
    try {
      port.postMessage({ type: "hello", ctx: "demo" } satisfies UiMessage);
    } catch {
      // Reload reconnects.
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
  }, []);

  // ---- pointer annotations (laser + circle drawing) --------------------------

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (annotationTool === "laser" && event.pointerType === "mouse") {
        const point = normalizedPoint(event);
        overlayRenderer.renderLaser(point);
        post({ type: "stage-laser", laser: { x: point.x, y: point.y, expiresAt: Date.now() + 1500 } });
      }
      if (circleDraft) {
        const point = normalizedPoint(event);
        const left = Math.min(circleDraft.startX, point.x);
        const top = Math.min(circleDraft.startY, point.y);
        circleDraft.element.style.left = `${left * 100}%`;
        circleDraft.element.style.top = `${top * 100}%`;
        circleDraft.element.style.width = `${Math.abs(point.x - circleDraft.startX) * 100}%`;
        circleDraft.element.style.height = `${Math.abs(point.y - circleDraft.startY) * 100}%`;
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (annotationTool !== "circle" || event.button !== 0 || event.target instanceof HTMLElement && event.target.closest("[data-showit-overlay]")) return;
      const host = overlayRenderer.root();
      if (!host) return;
      const point = normalizedPoint(event);
      const box = document.createElement("div");
      box.className = "showit-circle";
      box.style.left = `${point.x * 100}%`;
      box.style.top = `${point.y * 100}%`;
      box.style.width = "0%";
      box.style.height = "0%";
      host.append(box);
      circleDraft = { startX: point.x, startY: point.y, element: box };
    };
    const onPointerUp = () => {
      if (!circleDraft) return;
      const draft = circleDraft;
      circleDraft = null;
      const left = Number(draft.element.style.left!.slice(0, -1)) / 100;
      const top = Number(draft.element.style.top!.slice(0, -1)) / 100;
      const width = Number(draft.element.style.width!.slice(0, -1)) / 100;
      const height = Number(draft.element.style.height!.slice(0, -1)) / 100;
      draft.element.remove();
      if (width < 0.01 || height < 0.01) return;
      post({
        type: "action",
        action: { type: "add-circle", circle: { id: makeCircleId(), x1: left, y1: top, x2: left + width, y2: top + height } }
      });
    };
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    return () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
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
