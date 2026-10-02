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

/**
 * 内置遮挡页的卡通人物：纯 SVG + CSS 动画，不发请求、不依赖外部资源，
 * 所以离线也能动。人物会浮动、眨眼、挥手，避免遮挡页过于死板。
 */
export const MASK_MASCOT_SVG = `<svg class="showit-mascot-svg" viewBox="0 0 120 120" aria-hidden="true">
  <ellipse class="showit-mascot-shadow" cx="60" cy="108" rx="30" ry="5"/>
  <g class="showit-mascot-body">
    <rect x="34" y="60" width="52" height="38" rx="18" fill="#37d0ba"/>
    <g class="showit-mascot-arm">
      <rect x="86" y="62" width="10" height="24" rx="5" fill="#2bbfa6"/>
    </g>
    <circle cx="60" cy="46" r="26" fill="#4ce4cc"/>
    <g class="showit-mascot-eyes">
      <circle cx="51" cy="44" r="4.6" fill="#0d141b"/>
      <circle cx="69" cy="44" r="4.6" fill="#0d141b"/>
    </g>
    <path d="M51 54q9 8 18 0" fill="none" stroke="#0d141b" stroke-width="3" stroke-linecap="round"/>
    <rect x="30" y="70" width="9" height="20" rx="4.5" fill="#2bbfa6"/>
  </g>
</svg>`;

/** 构建遮挡封面内容：优先用项目配置的动图，否则用内置卡通人物。 */
function createMaskPage(mask: OverlayShape["mask"], documentRef: Document, fallbackTitle: string): HTMLElement {
  const page = documentRef.createElement("div");
  page.className = "showit-mask-page";
  const art = documentRef.createElement("div");
  art.className = "showit-mascot";
  if (mask?.imageDataUrl) {
    const image = documentRef.createElement("img");
    image.className = "showit-mask-image";
    image.alt = "";
    image.src = mask.imageDataUrl;
    art.append(image);
  } else {
    // 静态常量，不含任何项目数据。
    art.innerHTML = MASK_MASCOT_SVG;
  }
  const title = documentRef.createElement("p");
  title.className = "showit-mask-title";
  title.textContent = mask?.title || fallbackTitle;
  page.append(art, title);
  return page;
}

export const OVERLAY_STYLE = [
  ".showit-layer{position:absolute;inset:0;}",
  ".showit-cover{display:flex;align-items:center;justify-content:center;color:#fff;font:600 clamp(18px,3vw,30px)/1.4 system-ui,sans-serif;background:#172533;}",
  ".showit-cover.is-black{background:#050607;}",
  ".showit-cover.is-white{background:#fff;color:#0d1015;}",
  ".showit-cover.is-ended{background:#172533;}",
  ".showit-cover.is-mask{background:linear-gradient(160deg,#12202b,#0d1015);}",
  ".showit-mask-page{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:24px;text-align:center;}",
  ".showit-mascot{width:clamp(96px,12vw,140px);height:clamp(96px,12vw,140px);}",
  ".showit-mascot-svg{width:100%;height:100%;overflow:visible;}",
  ".showit-mask-image{max-width:220px;max-height:220px;object-fit:contain;}",
  ".showit-mask-title{margin:0;font-weight:600;font-size:clamp(18px,2.6vw,30px);line-height:1.5;}",
  ".showit-mascot-body{transform-origin:60px 104px;animation:showit-mascot-float 1.9s ease-in-out infinite;}",
  ".showit-mascot-arm{transform-origin:86px 64px;animation:showit-mascot-wave 1.15s ease-in-out infinite;}",
  ".showit-mascot-eyes{transform-origin:60px 44px;animation:showit-mascot-blink 3.6s ease-in-out infinite;}",
  ".showit-mascot-shadow{fill:#8fa0b2;opacity:.16;transform-origin:60px 108px;animation:showit-mascot-shadow 1.9s ease-in-out infinite;}",
  "@keyframes showit-mascot-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}",
  "@keyframes showit-mascot-wave{0%,100%{transform:rotate(-10deg)}50%{transform:rotate(30deg)}}",
  "@keyframes showit-mascot-blink{0%,90%,100%{transform:scaleY(1)}95%{transform:scaleY(.12)}}",
  "@keyframes showit-mascot-shadow{0%,100%{transform:scaleX(1);opacity:.16}50%{transform:scaleX(.8);opacity:.1}}",
  "@media (prefers-reduced-motion: reduce){.showit-mascot-body,.showit-mascot-arm,.showit-mascot-eyes,.showit-mascot-shadow{animation:none}}",
  ".showit-mask{position:absolute;background:#111820;}",
  ".showit-mask.is-blur{backdrop-filter:blur(18px);background:rgb(10 15 20 / 45%);}",
  ".showit-circle{position:absolute;border:3px solid #f4b44d;border-radius:50%;box-shadow:0 0 0 2px rgb(5 6 7 / 60%);}",
  ".showit-laser{position:absolute;width:18px;height:18px;border-radius:50%;background:#ff5f6d;box-shadow:0 0 16px 6px rgb(255 95 109 / 55%);transform:translate(-50%,-50%);}"
].join("\n");

export type OverlayShape = {
  screenMode: string;
  privacyMessage: string;
  /** 遮挡封面（screenMode=mask）：文案 + 可选自定义动图。 */
  mask: { title: string; imageDataUrl?: string | undefined } | null;
  privacyMasks: Array<{ id: string; x1: number; y1: number; x2: number; y2: number; mode: string }>;
  circles: Array<{ id: string; x1: number; y1: number; x2: number; y2: number }>;
};

export function createOverlayRenderer(documentRef: Document = document): {
  root(): HTMLDivElement | null;
  render(state: OverlayShape | null): void;
  renderLaser(laser: { x: number; y: number } | null): void;
} {
  let overlayRoot: HTMLDivElement | null = null;
  // 样式元素必须留在闭包里：render() 每次都会重建子节点，若靠 querySelector 找回，
  // 清空后再查永远拿不到 —— 结果是覆盖层样式丢失，所有标注变成没有样式的空 div，
  // 表现为"激光笔看不到、圈选画不出"。
  let overlayStyle: HTMLStyleElement | null = null;
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
    overlayStyle = style;
    host.append(style);
    (documentRef.documentElement ?? documentRef.body).append(host);
    overlayRoot = host;
    return host;
  }

  function render(state: OverlayShape | null): void {
    const host = ensureOverlayRoot();
    if (!host) return;
    // 状态广播可能在拖拽途中到达：正在画的草稿不能被清掉，否则这一笔会丢。
    const draft = host.querySelector<HTMLElement>(".showit-circle--draft");
    host.replaceChildren(...(overlayStyle ? [overlayStyle] : []));
    if (draft) host.append(draft);
    if (!state) return;

    const width = Math.max(1, documentRef.documentElement.clientWidth);
    const height = Math.max(1, documentRef.documentElement.clientHeight);

    if (state.screenMode !== "normal") {
      const cover = documentRef.createElement("div");
      cover.className = `showit-layer showit-cover${state.screenMode === "black" ? " is-black" : state.screenMode === "white" ? " is-white" : state.screenMode === "ended" ? " is-ended" : state.screenMode === "mask" ? " is-mask" : ""}`;
      if (state.screenMode === "mask") {
        cover.append(createMaskPage(state.mask, documentRef, "敏感信息遮挡，马上回来～"));
      } else {
        cover.textContent = state.screenMode === "ended" ? "演示已结束" : state.screenMode === "black" ? "" : state.screenMode === "white" ? "" : state.privacyMessage || "画面已保护";
      }
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

let selectionLockStyle: HTMLStyleElement | null = null;

/**
 * 标注工具激活期间禁止页面元素被选中。
 *
 * 激光笔与圈选都要在业务页面上按住鼠标划动，浏览器默认会把它当成“拖选文本”，于是
 * 业务页面的文字被高亮选中——演示画面上出现一片蓝色选区，非常难看。按下时
 * preventDefault 只能挡住起点，双击、拖出元素继续移动等情况仍然会选中，所以这里在
 * 工具激活期间直接给文档加类，整体禁用 user-select；工具回到“无”时立即解除。
 */
export function lockPageSelection(locked: boolean, documentRef: Document = document): void {
  if (locked && !selectionLockStyle) {
    const style = documentRef.createElement("style");
    style.setAttribute("data-showit-selection-lock", "1");
    // 只影响标注期间：工具类加上才生效，移除类即恢复原有行为（不改动业务页样式）。
    style.textContent = ".showit-annotation, .showit-annotation * { user-select: none !important; -webkit-user-select: none !important; }";
    documentRef.head.append(style);
    selectionLockStyle = style;
  }
  documentRef.documentElement.classList.toggle("showit-annotation", locked);
}

export type AnnotationHost = {
  /** 是否处于圈选工具 */
  isCircleTool(): boolean;
  /** 是否处于激光笔工具 */
  isLaserTool(): boolean;
  /** 一个圆画完（归一化坐标） */
  addCircle(circle: { x1: number; y1: number; x2: number; y2: number }): void;
  /** 激光笔移动（观众镜像等需要转发的场景） */
  moveLaser?(point: { x: number; y: number }): void;
};

/**
 * 指针标注（激光笔 + 圈选）的共用实现，业务页注入脚本与内置演示页共用一份，
 * 避免两处逻辑各自演化出不同的缺陷。
 *
 * 要点：
 * - 草稿用 .showit-circle--draft 标记，覆盖层重绘时会被保留（拖拽途中随时会有广播）。
 * - 同时监听 pointerup 与 pointercancel；若上一次拖拽没收到结束事件，下一次按下时
 *   按“已有尺寸就提交”收尾，绝不静默丢弃演讲者画过的那一笔。
 * - pointerdown 会阻止默认行为：拖过输入框时浏览器会误判成文本拖选并发 pointercancel，
 *   那样这一笔就没了。
 */
export function attachAnnotationLayer(
  host: AnnotationHost,
  renderer: ReturnType<typeof createOverlayRenderer>,
  documentRef: Document = document
): { detach(): void; cancel(): void } {
  let circleDraft: { startX: number; startY: number; element: HTMLDivElement } | null = null;

  const finishDraft = (commit: boolean) => {
    const draft = circleDraft;
    if (!draft) return;
    circleDraft = null;
    const left = Number(draft.element.style.left.slice(0, -1)) / 100;
    const top = Number(draft.element.style.top.slice(0, -1)) / 100;
    const width = Number(draft.element.style.width.slice(0, -1)) / 100;
    const height = Number(draft.element.style.height.slice(0, -1)) / 100;
    draft.element.remove();
    if (!commit || width < 0.01 || height < 0.01) return;
    host.addCircle({ x1: left, y1: top, x2: left + width, y2: top + height });
  };

  const onPointerMove = (event: PointerEvent) => {
    if (host.isLaserTool() && event.pointerType === "mouse") {
      const point = normalizedPoint(event);
      renderer.renderLaser(point);
      host.moveLaser?.(point);
    }
    if (!circleDraft) return;
    const point = normalizedPoint(event);
    circleDraft.element.style.left = `${Math.min(circleDraft.startX, point.x) * 100}%`;
    circleDraft.element.style.top = `${Math.min(circleDraft.startY, point.y) * 100}%`;
    circleDraft.element.style.width = `${Math.abs(point.x - circleDraft.startX) * 100}%`;
    circleDraft.element.style.height = `${Math.abs(point.y - circleDraft.startY) * 100}%`;
  };

  const onPointerDown = (event: PointerEvent) => {
    // 上一次拖拽若没收到 pointerup（DOM 变动、事件丢失都可能发生），这里按“已有尺寸
    // 就提交”收尾：宁可多留一个演讲者确实画过的圈，也不要把这 quietly 丢掉。
    finishDraft(true);
    if (!host.isCircleTool() || event.button !== 0) return;
    if (event.target instanceof HTMLElement && event.target.closest("[data-showit-overlay]")) return;
    const overlayRoot = renderer.root();
    if (!overlayRoot) return;
    // 拖过输入框或可选中内容时，Chrome 会把这一笔判成文本拖选并发 pointercancel，
    // 结果这一笔被无声丢弃。圈选模式下阻止默认行为即可保持 pointer 序列完整。
    event.preventDefault();
    const point = normalizedPoint(event);
    const box = documentRef.createElement("div");
    box.className = "showit-circle showit-circle--draft";
    box.style.left = `${point.x * 100}%`;
    box.style.top = `${point.y * 100}%`;
    box.style.width = "0%";
    box.style.height = "0%";
    overlayRoot.append(box);
    circleDraft = { startX: point.x, startY: point.y, element: box };
  };

  const onPointerUp = () => finishDraft(true);
  const onPointerCancel = () => finishDraft(false);

  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerCancel, true);
  return {
    detach() {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
    },
    /** 工具被切走时调用：丢弃尚未完成的草稿 */
    cancel() {
      finishDraft(false);
    }
  };
};

export function normalizedPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
  const width = Math.max(1, document.documentElement.clientWidth);
  const height = Math.max(1, document.documentElement.clientHeight);
  return { x: Math.max(0, Math.min(1, event.clientX / width)), y: Math.max(0, Math.min(1, event.clientY / height)) };
}

export function makeCircleId(): string {
  return `circle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
