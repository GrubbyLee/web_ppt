/**
 * Shared DOM connector logic used by BOTH hosts:
 * - the business-tab content script (injected into real business pages)
 * - the built-in demo console page (chrome-extension://, cannot be scripted —
 *   see docs/v0.2.1-内置演示系统方案.md, experiments E1/E2)
 *
 * Everything here is pure DOM: no chrome.* access. Hosts provide the messaging
 * glue (runtime.sendMessage / sendResponse) via the callbacks.
 */

export type Locator = { strategy: string; value: string };

export type ExecuteResult = { ok: boolean; performed?: string; reason?: string };

export type MaskBounds = { x1: number; y1: number; x2: number; y2: number };

export function safeText(value: unknown, limit = 160): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function isSensitiveElement(element: Element): boolean {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
  const identity = `${element.type} ${element.name} ${element.id} ${element.autocomplete}`;
  return element.type === "password" || /(password|passwd|secret|token|cookie|authorization|credential|api[-_]?key)/i.test(identity);
}

// ---- locators -----------------------------------------------------------------

export function locatorMatches(locator: Locator | null | undefined, documentRef: Document = document): HTMLElement[] {
  if (!locator || typeof locator.value !== "string" || locator.value.length > 200) return [];
  const all = locator.strategy === "id"
    ? [documentRef.getElementById(locator.value)].filter(Boolean)
    : locator.strategy === "testid"
      ? [...documentRef.querySelectorAll("[data-testid]")].filter((element) => element.getAttribute("data-testid") === locator.value)
      : locator.strategy === "aria"
        ? [...documentRef.querySelectorAll("[aria-label]")].filter((element) => element.getAttribute("aria-label") === locator.value)
        : locator.strategy === "role"
          ? [...documentRef.querySelectorAll("[role]")].filter((element) => element.getAttribute("role") === locator.value)
          : [];
  return all.filter((element): element is HTMLElement => element instanceof HTMLElement);
}

export function stableLocator(element: Element, documentRef: Document = document): Locator | null {
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
    if (locatorMatches(locator, documentRef).length === 1) return locator;
  }
  return null;
}

// ---- conditions ------------------------------------------------------------------

export function pageUrlWithoutSecrets(): string {
  return `${location.origin}${location.pathname}`;
}

export function checkCondition(condition: { type?: string } | null | undefined): boolean {
  if (!condition) return true;
  if (condition.type === "url") return pageUrlWithoutSecrets() === (condition as { value: string }).value;
  if (condition.type === "title") return document.title.includes((condition as { value: string }).value);
  if (condition.type === "text") return document.body?.innerText.includes((condition as { value: string }).value) === true;
  if (condition.type === "element") return locatorMatches((condition as { locator: Locator }).locator).length === 1;
  return false;
}

// ---- step execution -----------------------------------------------------------------

export function executeAction(action: { type?: string } & Record<string, unknown>, execution: string): ExecuteResult {
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

// ---- recorder -------------------------------------------------------------------------

export type RecorderHost = {
  send: (message: { type: "showit-recorded-action"; recordingId: string; action: unknown }) => void;
};

export function createRecorder(host: RecorderHost): { setRecording(recordingId: string | null): void; isActive(): boolean } {
  let recordingId: string | null = null;
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRecorded = { key: "", at: 0 };

  function record(action: unknown): void {
    if (!recordingId) return;
    const key = JSON.stringify(action);
    const now = Date.now();
    if (key === lastRecorded.key && now - lastRecorded.at < 500) return;
    lastRecorded = { key, at: now };
    host.send({ type: "showit-recorded-action", recordingId, action });
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

  return {
    setRecording,
    isActive: () => recordingId !== null
  };
}

// ---- privacy mask picking --------------------------------------------------------------

export function normalizedBounds(element: Element): MaskBounds {
  const rect = element.getBoundingClientRect();
  const width = Math.max(1, document.documentElement.clientWidth);
  const height = Math.max(1, document.documentElement.clientHeight);
  const clamp = (value: number, size: number) => Math.max(0, Math.min(1, value / size));
  return { x1: clamp(rect.left, width), y1: clamp(rect.top, height), x2: clamp(rect.right, width), y2: clamp(rect.bottom, height) };
}

export function pickMaskElement(sendResponse: (response: unknown) => void, isPicking: () => boolean, setPicking: (value: boolean) => void): () => void {
  if (isPicking()) {
    sendResponse({ ok: false, reason: "元素选择正在进行" });
    return () => undefined;
  }
  let cancel: (() => void) | null = null;
  const finish = (result: unknown) => {
    document.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKey, true);
    setPicking(false);
    cancel = null;
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
  cancel = () => finish({ ok: false, reason: "已取消元素选择" });
  setPicking(true);
  document.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKey, true);
  return () => cancel?.();
}

export function resolvePrivacyMasks(items: Array<{ id: string; locator: Locator }>): { resolved: Array<{ id: string; bounds: MaskBounds }>; missing: string[] } {
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

// ---- overlay (covers, masks, circles, laser) ---------------------------------------------

export const OVERLAY_STYLE = [
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

export type OverlayShape = {
  screenMode: string;
  privacyMessage: string;
  privacyMasks: Array<{ id: string; x1: number; y1: number; x2: number; y2: number; mode: string }>;
  circles: Array<{ id: string; x1: number; y1: number; x2: number; y2: number }>;
};

export function createOverlayRenderer(documentRef: Document = document): {
  root(): HTMLDivElement | null;
  render(state: OverlayShape | null): void;
  renderLaser(laser: { x: number; y: number } | null): void;
} {
  let overlayRoot: HTMLDivElement | null = null;
  let laserExpiryTimer: ReturnType<typeof setTimeout> | null = null;

  function ensureOverlayRoot(): HTMLDivElement | null {
    if (overlayRoot?.isConnected) return overlayRoot;
    const host = documentRef.createElement("div");
    host.setAttribute("data-showit-overlay", "1");
    Object.assign(host.style, {
      all: "initial",
      position: "fixed",
      inset: "0",
      zIndex: "2147483646",
      pointerEvents: "none"
    } satisfies Partial<CSSStyleDeclaration>);
    const style = documentRef.createElement("style");
    style.textContent = OVERLAY_STYLE;
    host.append(style);
    (documentRef.documentElement ?? documentRef.body).append(host);
    overlayRoot = host;
    return host;
  }

  function render(state: OverlayShape | null): void {
    const host = ensureOverlayRoot();
    if (!host) return;
    host.replaceChildren();
    const style = host.querySelector("style");
    if (style) host.append(style);
    if (!state) return;

    const width = Math.max(1, documentRef.documentElement.clientWidth);
    const height = Math.max(1, documentRef.documentElement.clientHeight);

    if (state.screenMode !== "normal") {
      const cover = documentRef.createElement("div");
      cover.className = `showit-layer showit-cover${state.screenMode === "black" ? " is-black" : state.screenMode === "white" ? " is-white" : state.screenMode === "ended" ? " is-ended" : ""}`;
      cover.textContent = state.screenMode === "ended" ? "演示已结束" : state.screenMode === "black" ? "" : state.screenMode === "white" ? "" : state.privacyMessage || "画面已保护";
      host.append(cover);
      return;
    }

    for (const mask of state.privacyMasks) {
      const box = documentRef.createElement("div");
      box.className = `showit-mask${mask.mode === "blur" ? " is-blur" : ""}`;
      box.style.left = `${Math.min(mask.x1, mask.x2) * 100}%`;
      box.style.top = `${Math.min(mask.y1, mask.y2) * 100}%`;
      box.style.width = `${Math.abs(mask.x2 - mask.x1) * 100}%`;
      box.style.height = `${Math.abs(mask.y2 - mask.y1) * 100}%`;
      host.append(box);
    }

    for (const circle of state.circles) {
      const ring = documentRef.createElement("div");
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
      dot = documentRef.createElement("div");
      dot.className = "showit-laser";
      host.append(dot);
    }
    dot.style.left = `${laser.x * 100}%`;
    dot.style.top = `${laser.y * 100}%`;
    laserExpiryTimer = setTimeout(() => dot!.remove(), 1500);
  }

  return { root: () => overlayRoot, render, renderLaser };
}

export function normalizedPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
  const width = Math.max(1, document.documentElement.clientWidth);
  const height = Math.max(1, document.documentElement.clientHeight);
  return { x: Math.max(0, Math.min(1, event.clientX / width)), y: Math.max(0, Math.min(1, event.clientY / height)) };
}

export function makeCircleId(): string {
  return `circle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
