import { browser } from "wxt/browser";
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { probeConnectorSession } from "@/lib/connector-session";
import type { OverlayState } from "@/messaging/protocol";

/**
 * Unlisted script injected on demand into the session business tab via
 * chrome.scripting.executeScript. Carries the v0.1 connector (probe,
 * recorder, step execution, mask picking) plus the presenter overlay
 * (annotations, privacy masks, screen covers, laser pointer).
 */

export default defineUnlistedScript(() => {
  if (!(globalThis as { __showitConnectorLoaded?: boolean }).__showitConnectorLoaded) {

  (globalThis as { __showitConnectorLoaded?: boolean }).__showitConnectorLoaded = true;

  let recordingId: string | null = null;
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRecorded = { key: "", at: 0 };
  let maskPicker: (() => void) | null = null;
  let resourceFailureCount = 0;
  let resourceFailureTimer: ReturnType<typeof setTimeout> | null = null;
  let overlay: OverlayState | null = null;
  let laserExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  let overlayRoot: HTMLDivElement | null = null;
  let circleDraft: { startX: number; startY: number; element: HTMLDivElement } | null = null;

  function safeText(value: unknown, limit = 160): string {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function isSensitiveElement(element: Element): boolean {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
    const identity = `${element.type} ${element.name} ${element.id} ${element.autocomplete}`;
    return element.type === "password" || /(password|passwd|secret|token|cookie|authorization|credential|api[-_]?key)/i.test(identity);
  }

  // ---- overlay rendering -------------------------------------------------------

  function ensureOverlayRoot(): HTMLDivElement | null {
    if (overlayRoot?.isConnected) return overlayRoot;
    const host = document.createElement("div");
    host.setAttribute("data-showit-overlay", "1");
    Object.assign(host.style, {
      all: "initial",
      position: "fixed",
      inset: "0",
      zIndex: "2147483646",
      pointerEvents: "none"
    } satisfies Partial<CSSStyleDeclaration>);
    const style = document.createElement("style");
    style.textContent = [
      ".showit-layer{position:absolute;inset:0;}",
      ".showit-cover{display:flex;align-items:center;justify-content:center;color:#fff;font:600 clamp(18px,3vw,30px)/1.4 system-ui,sans-serif;background:#172533;}",
      ".showit-cover.is-black{background:#050607;}",
      ".showit-cover.is-white{background:#fff;color:#0d1015;}",
      ".showit-cover.is-ended{background:#172533;}",
      ".showit-mask{position:absolute;background:#111820;}",
      ".showit-mask.is-blur{backdrop-filter:blur(18px);background:rgb(10 15 20 / 45%);}",
      ".showit-circle{position:absolute;border:3px solid #f4b44d;border-radius:50%;box-shadow:0 0 0 2px rgb(5 6 7 / 60%);}",
      ".showit-laser{position:absolute;width:18px;height:18px;border-radius:50%;background:#ff5f6d;box-shadow:0 0 16px 6px rgb(255 95 109 / 55%);transform:translate(-50%,-50%);}"
    ].join("\n");
    host.append(style);
    (document.documentElement ?? document.body).append(host);
    overlayRoot = host;
    return host;
  }

  function renderOverlay(): void {
    const host = ensureOverlayRoot();
    if (!host) return;
    const state = overlay;
    host.replaceChildren();
    const style = host.querySelector("style");
    if (style) host.append(style);
    if (!state) return;

    const width = Math.max(1, document.documentElement.clientWidth);
    const height = Math.max(1, document.documentElement.clientHeight);

    if (state.screenMode !== "normal") {
      const cover = document.createElement("div");
      cover.className = `showit-layer showit-cover${state.screenMode === "black" ? " is-black" : state.screenMode === "white" ? " is-white" : state.screenMode === "ended" ? " is-ended" : ""}`;
      cover.textContent = state.screenMode === "ended" ? "演示已结束" : state.screenMode === "black" ? "" : state.screenMode === "white" ? "" : state.brand.privacyMessage || "画面已保护";
      host.append(cover);
      return;
    }

    for (const mask of state.privacyMasks) {
      const box = document.createElement("div");
      box.className = `showit-mask${mask.mode === "blur" ? " is-blur" : ""}`;
      box.style.left = `${Math.min(mask.x1, mask.x2) * 100}%`;
      box.style.top = `${Math.min(mask.y1, mask.y2) * 100}%`;
      box.style.width = `${Math.abs(mask.x2 - mask.x1) * 100}%`;
      box.style.height = `${Math.abs(mask.y2 - mask.y1) * 100}%`;
      host.append(box);
    }

    for (const circle of state.circles) {
      const ring = document.createElement("div");
      ring.className = "showit-circle";
      ring.style.left = `${Math.min(circle.x1, circle.x2) * width}px`;
      ring.style.top = `${Math.min(circle.y1, circle.y2) * height}px`;
      ring.style.width = `${Math.abs(circle.x2 - circle.x1) * width}px`;
      ring.style.height = `${Math.abs(circle.y2 - circle.y1) * height}px`;
      host.append(ring);
    }
  }

  function renderLaser(laser: { x: number; y: number } | null): void {
    if (laserExpiryTimer) {
      clearTimeout(laserExpiryTimer);
      laserExpiryTimer = null;
    }
    const existing = overlayRoot?.querySelector(".showit-laser");
    if (!laser) {
      existing?.remove();
      return;
    }
    let dot = existing as HTMLDivElement | null;
    if (!dot) {
      const host = ensureOverlayRoot();
      if (!host) return;
      dot = document.createElement("div");
      dot.className = "showit-laser";
      host.append(dot);
    }
    dot.style.left = `${laser.x * 100}%`;
    dot.style.top = `${laser.y * 100}%`;
    laserExpiryTimer = setTimeout(() => dot!.remove(), 1500);
  }

  // ---- pointer annotations (laser + circle drawing) -------------------------------

  function normalizedPoint(event: PointerEvent | MouseEvent): { x: number; y: number } {
    const width = Math.max(1, document.documentElement.clientWidth);
    const height = Math.max(1, document.documentElement.clientHeight);
    return { x: Math.max(0, Math.min(1, event.clientX / width)), y: Math.max(0, Math.min(1, event.clientY / height)) };
  }

  function annotationPointerMove(event: PointerEvent): void {
    if (overlay?.annotationTool === "laser" && event.pointerType === "mouse") {
      renderLaser(normalizedPoint(event));
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
    const host = ensureOverlayRoot();
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
      circle: {
        id: `circle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        x1: left,
        y1: top,
        x2: left + width,
        y2: top + height
      }
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
      lastPrivacyRisk = null;
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

  // ---- locators -------------------------------------------------------------------

  type Locator = { strategy: string; value: string };

  function locatorMatches(locator: Locator | null | undefined): HTMLElement[] {
    if (!locator || typeof locator.value !== "string" || locator.value.length > 200) return [];
    const all = locator.strategy === "id"
      ? [document.getElementById(locator.value)].filter(Boolean)
      : locator.strategy === "testid"
        ? [...document.querySelectorAll("[data-testid]")].filter((element) => element.getAttribute("data-testid") === locator.value)
        : locator.strategy === "aria"
          ? [...document.querySelectorAll("[aria-label]")].filter((element) => element.getAttribute("aria-label") === locator.value)
          : locator.strategy === "role"
            ? [...document.querySelectorAll("[role]")].filter((element) => element.getAttribute("role") === locator.value)
            : [];
    return all.filter((element): element is HTMLElement => element instanceof HTMLElement);
  }

  function stableLocator(element: Element): Locator | null {
    const candidates: Array<[string, string | null]> = [
      ["testid", element.getAttribute("data-testid")],
      ["id", element instanceof HTMLElement ? element.id : null],
      ["aria", element.getAttribute("aria-label")],
      ["role", element.getAttribute("role")]
    ];
    for (const [strategy, rawValue] of candidates) {
      const value = safeText(rawValue, 200);
      if (!value || /(password|passwd|secret|token|cookie|authorization|credential|api[-_]?key)/i.test(value)) continue;
      const locator = { strategy, value };
      if (locatorMatches(locator).length === 1) return locator;
    }
    return null;
  }

  // ---- recorder ---------------------------------------------------------------------

  function record(action: unknown): void {
    if (!recordingId) return;
    const key = JSON.stringify(action);
    const now = Date.now();
    if (key === lastRecorded.key && now - lastRecorded.at < 500) return;
    lastRecorded = { key, at: now };
    void browser.runtime.sendMessage({ type: "showit-recorded-action", recordingId, action }).catch(() => undefined);
  }

  function onRecordedClick(event: Event): void {
    const target = event.target instanceof Element ? event.target.closest("button,a,input,select,textarea,[role]") : null;
    if (!(target instanceof HTMLElement) || isSensitiveElement(target)) return;
    const locator = stableLocator(target);
    if (!locator) return;
    const label = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? "" : safeText(target.getAttribute("aria-label") || target.textContent);
    record(label ? { type: "click", locator, label } : { type: "click", locator });
  }

  function onRecordedFocus(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) || isSensitiveElement(target)) return;
    const locator = stableLocator(target);
    if (locator) record({ type: "focus", locator });
  }

  function onRecordedChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) || isSensitiveElement(target)) return;
    const locator = stableLocator(target);
    if (!locator) return;
    const label = safeText(target.getAttribute("aria-label") || target.labels?.[0]?.textContent);
    record(label ? { type: "fill", locator, input: { source: "fixed", value: "" }, label } : { type: "fill", locator, input: { source: "fixed", value: "" } });
  }

  function onRecordedScroll(): void {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => record({ type: "scroll", x: Math.max(0, Math.round(scrollX)), y: Math.max(0, Math.round(scrollY)) }), 300);
  }

  function setRecording(nextRecordingId: string | null): void {
    const active = typeof nextRecordingId === "string" && nextRecordingId.length > 0;
    recordingId = active ? nextRecordingId!.slice(0, 120) : null;
    document.removeEventListener("click", onRecordedClick, true);
    document.removeEventListener("focusin", onRecordedFocus, true);
    document.removeEventListener("change", onRecordedChange, true);
    window.removeEventListener("scroll", onRecordedScroll, true);
    if (active) {
      document.addEventListener("click", onRecordedClick, true);
      document.addEventListener("focusin", onRecordedFocus, true);
      document.addEventListener("change", onRecordedChange, true);
      window.addEventListener("scroll", onRecordedScroll, true);
    }
  }

  // ---- step execution -----------------------------------------------------------------

  function pageUrlWithoutSecrets(): string {
    return `${location.origin}${location.pathname}`;
  }

  function checkCondition(condition: { type?: string } | null | undefined): boolean {
    if (!condition) return true;
    if (condition.type === "url") return pageUrlWithoutSecrets() === (condition as { value: string }).value;
    if (condition.type === "title") return document.title.includes((condition as { value: string }).value);
    if (condition.type === "text") return document.body?.innerText.includes((condition as { value: string }).value) === true;
    if (condition.type === "element") return locatorMatches((condition as { locator: Locator }).locator).length === 1;
    return false;
  }

  function executeAction(action: { type?: string } & Record<string, unknown>, execution: string): { ok: boolean; performed?: string; reason?: string } {
    if (!action || execution === "hint") return { ok: true, performed: "hint" };
    if (action.type === "navigate") return { ok: false, reason: "navigation-background-required" };
    if (action.type === "scroll") {
      window.scrollTo({ left: Number(action.x), top: Number(action.y), behavior: "smooth" });
      return { ok: true, performed: "scroll" };
    }
    const matches = locatorMatches(action.locator as Locator);
    if (matches.length !== 1) return { ok: false, reason: matches.length === 0 ? "元素无法定位" : "定位器命中多个元素" };
    const element = matches[0]!;
    element.scrollIntoView({ block: "center", inline: "center" });
    const previousOutline = element.style.outline;
    element.style.outline = "3px solid #ffbd59";
    setTimeout(() => { element.style.outline = previousOutline; }, 1800);
    if (execution === "highlight") return { ok: true, performed: "highlight" };
    if (action.type === "fill") {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return { ok: false, reason: "目标不是可填写控件" };
      element.focus({ preventScroll: true });
      if (execution !== "auto") return { ok: true, performed: "focus" };
      if (element.disabled || (!(element instanceof HTMLSelectElement) && element.readOnly)) return { ok: false, reason: "目标控件不可编辑" };
      const prototype = element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLSelectElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) return { ok: false, reason: "目标控件不支持安全填写" };
      setter.call(element, action.value as string);
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return { ok: true, performed: "fill" };
    }
    if (action.type === "focus") {
      element.focus({ preventScroll: true });
      return { ok: true, performed: "focus" };
    }
    if (action.type === "click" && execution === "auto") {
      element.click();
      return { ok: true, performed: "click" };
    }
    return { ok: true, performed: "highlight" };
  }

  // ---- privacy mask picking --------------------------------------------------------------

  function normalizedBounds(element: Element): { x1: number; y1: number; x2: number; y2: number } {
    const rect = element.getBoundingClientRect();
    const width = Math.max(1, document.documentElement.clientWidth);
    const height = Math.max(1, document.documentElement.clientHeight);
    const clamp = (value: number, size: number) => Math.max(0, Math.min(1, value / size));
    return { x1: clamp(rect.left, width), y1: clamp(rect.top, height), x2: clamp(rect.right, width), y2: clamp(rect.bottom, height) };
  }

  function pickMaskElement(sendResponse: (response: unknown) => void): void {
    if (maskPicker) {
      sendResponse({ ok: false, reason: "元素选择正在进行" });
      return;
    }
    const finish = (result: unknown) => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey, true);
      maskPicker = null;
      sendResponse(result);
    };
    const onClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const target = event.target instanceof Element ? event.target.closest("*") : null;
      if (!(target instanceof HTMLElement) || isSensitiveElement(target)) return finish({ ok: false, reason: "不能绑定敏感元素" });
      const locator = stableLocator(target);
      if (!locator) return finish({ ok: false, reason: "元素没有唯一稳定定位器" });
      finish({ ok: true, locator, bounds: normalizedBounds(target) });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish({ ok: false, reason: "已取消元素选择" });
    };
    maskPicker = () => finish({ ok: false, reason: "已取消元素选择" });
    document.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
  }

  function resolvePrivacyMasks(items: Array<{ id: string; locator: Locator }>): { resolved: Array<{ id: string; bounds: { x1: number; y1: number; x2: number; y2: number } }>; missing: string[] } {
    const resolved = [];
    const missing = [];
    for (const item of Array.isArray(items) ? items.slice(0, 30) : []) {
      if (!item || typeof item.id !== "string") continue;
      const matches = locatorMatches(item.locator);
      const element = matches.length === 1 ? matches[0] : null;
      const rect = element?.getBoundingClientRect();
      if (!element || !rect || rect.width <= 0 || rect.height <= 0) {
        missing.push(item.id);
        continue;
      }
      resolved.push({ id: item.id, bounds: normalizedBounds(element) });
    }
    return { resolved, missing };
  }

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
      setRecording(message.recordingId as string);
      sendResponse({ ok: Boolean(recordingId), url: pageUrlWithoutSecrets(), title: document.title });
      return false;
    }
    if (message?.type === "showit-recorder-stop") {
      setRecording(null);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "showit-execute-action") {
      sendResponse(executeAction(message.action as { type?: string } & Record<string, unknown>, message.execution as string));
      return false;
    }
    if (message?.type === "showit-check-condition") {
      sendResponse({ ok: checkCondition(message.condition as { type?: string }), url: pageUrlWithoutSecrets(), title: document.title });
      return false;
    }
    if (message?.type === "showit-pick-privacy-mask") {
      pickMaskElement(sendResponse);
      return true;
    }
    if (message?.type === "showit-cancel-privacy-mask") {
      maskPicker?.();
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
      const previousTool = overlay?.annotationTool;
      overlay = message.overlay as OverlayState;
      if (previousTool !== overlay.annotationTool) {
        renderLaser(null);
        if (overlay.annotationTool !== "circle" && circleDraft) {
          circleDraft.element.remove();
          circleDraft = null;
        }
      }
      renderOverlay();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
  }


});
