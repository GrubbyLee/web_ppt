import { browser } from "wxt/browser";
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { probeConnectorSession } from "@/lib/connector-session";
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
import type { OverlayState } from "@/messaging/protocol";

/**
 * Unlisted script injected on demand into the session business tab via
 * chrome.scripting.executeScript. Carries the v0.1 connector (probe,
 * recorder, step execution, mask picking) plus the presenter overlay
 * (annotations, privacy masks, screen covers, laser pointer).
 *
 * DOM logic lives in lib/dom-connector.ts and is shared with the built-in
 * demo console page.
 */

export default defineUnlistedScript(() => {
  if ((globalThis as { __showitConnectorLoaded?: boolean }).__showitConnectorLoaded) return;
  (globalThis as { __showitConnectorLoaded?: boolean }).__showitConnectorLoaded = true;

  let overlay: OverlayState | null = null;
  let maskPickerCancel: (() => void) | null = null;
  let resourceFailureCount = 0;
  let resourceFailureTimer: ReturnType<typeof setTimeout> | null = null;
  let circleDraft: { startX: number; startY: number; element: HTMLDivElement } | null = null;

  const overlayRenderer = createOverlayRenderer();

  const recorder = createRecorder({
    send: (message) => {
      void browser.runtime.sendMessage(message).catch(() => undefined);
    }
  });

  // ---- overlay sync (pushed by the background) ---------------------------------

  function applyOverlay(next: OverlayState): void {
    const previousTool = overlay?.annotationTool;
    overlay = next;
    if (previousTool !== overlay.annotationTool) {
      overlayRenderer.renderLaser(null);
      if (overlay.annotationTool !== "circle" && circleDraft) {
        circleDraft.element.remove();
        circleDraft = null;
      }
    }
    overlayRenderer.render({
      screenMode: overlay.screenMode,
      privacyMessage: overlay.brand.privacyMessage,
      privacyMasks: overlay.privacyMasks,
      circles: overlay.circles
    });
  }

  // ---- pointer annotations (laser + circle drawing) -------------------------------

  function annotationPointerMove(event: PointerEvent): void {
    if (overlay?.annotationTool === "laser" && event.pointerType === "mouse") {
      overlayRenderer.renderLaser(normalizedPoint(event));
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
  }

  function annotationPointerDown(event: PointerEvent): void {
    if (overlay?.annotationTool !== "circle" || event.button !== 0 || event.target instanceof HTMLElement && event.target.closest("[data-showit-overlay]")) return;
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
  }

  function annotationPointerUp(): void {
    if (!circleDraft) return;
    const draft = circleDraft;
    circleDraft = null;
    const left = Number(draft.element.style.left!.slice(0, -1)) / 100;
    const top = Number(draft.element.style.top!.slice(0, -1)) / 100;
    const width = Number(draft.element.style.width!.slice(0, -1)) / 100;
    const height = Number(draft.element.style.height!.slice(0, -1)) / 100;
    draft.element.remove();
    if (width < 0.01 || height < 0.01) return;
    if (!overlay) return;
    void browser.runtime.sendMessage({
      type: "showit-circle-added",
      sessionId: overlay.sessionId,
      circle: { id: makeCircleId(), x1: left, y1: top, x2: left + width, y2: top + height }
    }).catch(() => undefined);
  }

  window.addEventListener("pointermove", annotationPointerMove, true);
  window.addEventListener("pointerdown", annotationPointerDown, true);
  window.addEventListener("pointerup", annotationPointerUp, true);

  // ---- privacy risk detection ----------------------------------------------------

  function detectPrivacyRisk(): string | null {
    if (document.querySelector('input[type="password"]')) return "password";
    if (document.querySelector('input[type="file"]')) return "file";
    if (document.querySelector('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="mfa" i], input[id*="mfa" i]')) return "mfa";
    const authPage = /(?:^|[/._-])(sso|signin|sign-in|login|authenticate|oauth|saml)(?:$|[/._-])/i.test(location.pathname);
    if (authPage && document.querySelector("form input")) return "sso";
    return null;
  }

  let lastPrivacyRisk: string | null = null;
  let privacyRiskTimer: ReturnType<typeof setTimeout> | null = null;
  function reportPrivacyRisk(): void {
    const risk = detectPrivacyRisk();
    if (!risk) {
      if (lastPrivacyRisk === null) return;
      lastPrivacyRisk = null;
      // The sensitive input disappeared — let the background re-probe so the
      // audience privacy cover lifts.
      void browser.runtime.sendMessage({ type: "showit-privacy-risk", origin: location.origin, privacyRisk: null }).catch(() => undefined);
      return;
    }
    if (risk === lastPrivacyRisk) return;
    lastPrivacyRisk = risk;
    void browser.runtime.sendMessage({ type: "showit-privacy-risk", origin: location.origin, privacyRisk: risk }).catch(() => undefined);
  }
  function schedulePrivacyRiskCheck(): void {
    if (privacyRiskTimer !== null) return;
    privacyRiskTimer = setTimeout(() => {
      privacyRiskTimer = null;
      reportPrivacyRisk();
    }, 100);
  }
  new MutationObserver(schedulePrivacyRiskCheck).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["type", "autocomplete", "name", "id"] });
  document.addEventListener("focusin", schedulePrivacyRiskCheck, true);
  reportPrivacyRisk();

  window.addEventListener("error", (event) => {
    if (!(event.target instanceof HTMLImageElement || event.target instanceof HTMLScriptElement || event.target instanceof HTMLLinkElement || event.target instanceof HTMLMediaElement)) return;
    resourceFailureCount += 1;
    if (resourceFailureTimer !== null) return;
    resourceFailureTimer = setTimeout(() => {
      resourceFailureTimer = null;
      void browser.runtime.sendMessage({ type: "showit-resource-failures", origin: location.origin, count: resourceFailureCount }).catch(() => undefined);
    }, 250);
  }, true);

  // ---- business page bridge ----------------------------------------------------------------

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data as { __showitConnector?: number; type?: string; state?: string; role?: unknown };
    if (!message || message.__showitConnector !== 1 || message.type !== "showit:connector-state") return;
    const allowedStates = new Set(["ready", "anonymous", "role-mismatch", "loading", "error", "blocked"]);
    if (!allowedStates.has(message.state ?? "")) return;
    void browser.runtime.sendMessage({
      type: "business-page-message",
      origin: location.origin,
      title: document.title,
      payload: {
        type: "showit:connector-state",
        state: message.state,
        role: typeof message.role === "string" ? message.role.slice(0, 80) : undefined
      }
    }).catch(() => undefined);
  });

  // ---- message router ------------------------------------------------------------------------

  browser.runtime.onMessage.addListener((message: { type?: string } & Record<string, unknown>, _sender, sendResponse) => {
    if (message?.type === "showit-probe") {
      const privacyRisk = detectPrivacyRisk();
      sendResponse({
        origin: location.origin,
        title: document.title,
        hasPasswordField: privacyRisk === "password",
        privacyRisk
      });
      return false;
    }
    if (message?.type === "showit-recorder-start") {
      recorder.setRecording(message.recordingId as string);
      sendResponse({ ok: recorder.isActive(), url: `${location.origin}${location.pathname}`, title: document.title });
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
      sendResponse({ ok: checkCondition(message.condition as { type?: string }), url: `${location.origin}${location.pathname}`, title: document.title });
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
    if (message?.type === "showit-session-probe") {
      void (async () => {
        const connector = message.connector as Parameters<typeof probeConnectorSession>[2];
        const role = message.role as string;
        const result = await probeConnectorSession(location.href, role, connector, (input, init) => fetch(input, { ...init, credentials: "include" }), 4000);
        void browser.runtime.sendMessage({
          type: "showit-session-probe-result",
          sessionId: (message.sessionId as string) ?? overlay?.sessionId ?? "",
          state: result.state,
          role: result.state === "ready" || result.state === "role-mismatch" ? result.role : undefined,
          reason: result.state === "error" ? "会话探测失败" : undefined
        }).catch(() => undefined);
        sendResponse({ state: result.state, role: result.state === "ready" || result.state === "role-mismatch" ? result.role : undefined });
      })();
      return true;
    }
    if (message?.type === "showit-overlay") {
      applyOverlay(message.overlay as OverlayState);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

});
