if (!globalThis.__showitConnectorLoaded) {
  globalThis.__showitConnectorLoaded = true;
  let recordingId = null;
  let scrollTimer = null;
  let lastRecorded = { key: "", at: 0 };
  let maskPicker = null;
  let resourceFailureCount = 0;
  let resourceFailureTimer = null;

  function safeText(value, limit = 160) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function isSensitiveElement(element) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
    const identity = `${element.type} ${element.name} ${element.id} ${element.autocomplete}`;
    return element.type === "password" || /(password|passwd|secret|token|cookie|authorization|credential|api[-_]?key)/i.test(identity);
  }

  function detectPrivacyRisk() {
    if (document.querySelector('input[type="password"]')) return "password";
    if (document.querySelector('input[type="file"]')) return "file";
    if (document.querySelector('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="mfa" i], input[id*="mfa" i]')) return "mfa";
    const authPage = /(?:^|[/._-])(sso|signin|sign-in|login|authenticate|oauth|saml)(?:$|[/._-])/i.test(location.pathname);
    if (authPage && document.querySelector("form input")) return "sso";
    return null;
  }

  let lastPrivacyRisk = null;
  let privacyRiskTimer = null;
  function reportPrivacyRisk() {
    const risk = detectPrivacyRisk();
    if (!risk || risk === lastPrivacyRisk) return;
    lastPrivacyRisk = risk;
    chrome.runtime.sendMessage({ type: "showit-privacy-risk", origin: location.origin, privacyRisk: risk });
  }
  function schedulePrivacyRiskCheck() {
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
      chrome.runtime.sendMessage({ type: "showit-resource-failures", origin: location.origin, count: resourceFailureCount });
    }, 250);
  }, true);

  function locatorMatches(locator) {
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
    return all.filter((element) => element instanceof HTMLElement);
  }

  function stableLocator(element) {
    const candidates = [
      ["testid", element.getAttribute("data-testid")],
      ["id", element.id],
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

  function record(action) {
    if (!recordingId) return;
    const key = JSON.stringify(action);
    const now = Date.now();
    if (key === lastRecorded.key && now - lastRecorded.at < 500) return;
    lastRecorded = { key, at: now };
    chrome.runtime.sendMessage({ type: "showit-recorded-action", recordingId, action });
  }

  function onRecordedClick(event) {
    const target = event.target instanceof Element ? event.target.closest("button,a,input,select,textarea,[role]") : null;
    if (!(target instanceof HTMLElement) || isSensitiveElement(target)) return;
    const locator = stableLocator(target);
    if (!locator) return;
    const label = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? "" : safeText(target.getAttribute("aria-label") || target.textContent);
    record({ type: "click", locator, ...(label ? { label } : {}) });
  }

  function onRecordedFocus(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) || isSensitiveElement(target)) return;
    const locator = stableLocator(target);
    if (locator) record({ type: "focus", locator });
  }

  function onRecordedChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) || isSensitiveElement(target)) return;
    const locator = stableLocator(target);
    if (!locator) return;
    const label = safeText(target.getAttribute("aria-label") || target.labels?.[0]?.textContent);
    record({ type: "fill", locator, input: { source: "fixed", value: "" }, ...(label ? { label } : {}) });
  }

  function onRecordedScroll() {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => record({ type: "scroll", x: Math.max(0, Math.round(scrollX)), y: Math.max(0, Math.round(scrollY)) }), 300);
  }

  function setRecording(nextRecordingId) {
    const active = typeof nextRecordingId === "string" && nextRecordingId.length > 0;
    recordingId = active ? nextRecordingId.slice(0, 120) : null;
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

  function pageUrlWithoutSecrets() {
    return `${location.origin}${location.pathname}`;
  }

  function checkCondition(condition) {
    if (!condition) return true;
    if (condition.type === "url") return pageUrlWithoutSecrets() === condition.value;
    if (condition.type === "title") return document.title.includes(condition.value);
    if (condition.type === "text") return document.body?.innerText.includes(condition.value) === true;
    if (condition.type === "element") return locatorMatches(condition.locator).length === 1;
    return false;
  }

  function executeAction(action, execution) {
    if (!action || execution === "hint") return { ok: true, performed: "hint" };
    if (action.type === "navigate") return { ok: false, reason: "navigation-background-required" };
    if (action.type === "scroll") {
      window.scrollTo({ left: action.x, top: action.y, behavior: "smooth" });
      return { ok: true, performed: "scroll" };
    }
    const matches = locatorMatches(action.locator);
    if (matches.length !== 1) return { ok: false, reason: matches.length === 0 ? "元素无法定位" : "定位器命中多个元素" };
    const element = matches[0];
    element.scrollIntoView({ block: "center", inline: "center" });
    const previousOutline = element.style.outline;
    element.style.outline = "3px solid #ffbd59";
    setTimeout(() => { element.style.outline = previousOutline; }, 1800);
    if (execution === "highlight") return { ok: true, performed: "highlight" };
    if (action.type === "fill") {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return { ok: false, reason: "目标不是可填写控件" };
      element.focus({ preventScroll: true });
      if (execution !== "auto") return { ok: true, performed: "focus" };
      if (element.disabled || element.readOnly) return { ok: false, reason: "目标控件不可编辑" };
      const prototype = element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLSelectElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) return { ok: false, reason: "目标控件不支持安全填写" };
      setter.call(element, action.value);
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

  function normalizedBounds(element) {
    const rect = element.getBoundingClientRect();
    const width = Math.max(1, document.documentElement.clientWidth);
    const height = Math.max(1, document.documentElement.clientHeight);
    const clamp = (value, size) => Math.max(0, Math.min(1, value / size));
    return { x1: clamp(rect.left, width), y1: clamp(rect.top, height), x2: clamp(rect.right, width), y2: clamp(rect.bottom, height) };
  }

  function pickMaskElement(sendResponse) {
    if (maskPicker) return sendResponse({ ok: false, reason: "元素选择正在进行" });
    const finish = (result) => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey, true);
      maskPicker = null;
      sendResponse(result);
    };
    const onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const target = event.target instanceof Element ? event.target.closest("*") : null;
      if (!(target instanceof HTMLElement) || isSensitiveElement(target)) return finish({ ok: false, reason: "不能绑定敏感元素" });
      const locator = stableLocator(target);
      if (!locator) return finish({ ok: false, reason: "元素没有唯一稳定定位器" });
      finish({ ok: true, locator, bounds: normalizedBounds(target) });
    };
    const onKey = (event) => { if (event.key === "Escape") finish({ ok: false, reason: "已取消元素选择" }); };
    maskPicker = () => finish({ ok: false, reason: "已取消元素选择" });
    document.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
  }

  function resolvePrivacyMasks(items) {
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

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.__showitConnector !== 1 || message.type !== "showit:connector-state") return;
    const allowedStates = new Set(["ready", "anonymous", "role-mismatch", "loading", "error", "blocked"]);
    if (!allowedStates.has(message.state)) return;
    chrome.runtime.sendMessage({
      type: "business-page-message",
      origin: location.origin,
      title: document.title,
      payload: {
        type: "showit:connector-state",
        state: message.state,
        role: typeof message.role === "string" ? message.role.slice(0, 80) : undefined
      }
    });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "showit-probe") {
      const privacyRisk = detectPrivacyRisk();
      sendResponse({
        origin: location.origin,
        title: document.title,
        hasPasswordField: privacyRisk === "password",
        privacyRisk
      });
      return;
    }
    if (message?.type === "showit-recorder-start") {
      setRecording(message.recordingId);
      sendResponse({ ok: Boolean(recordingId), url: pageUrlWithoutSecrets(), title: document.title });
      return;
    }
    if (message?.type === "showit-recorder-stop") {
      setRecording(null);
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "showit-execute-action") {
      sendResponse(executeAction(message.action, message.execution));
      return;
    }
    if (message?.type === "showit-check-condition") {
      sendResponse({ ok: checkCondition(message.condition), url: pageUrlWithoutSecrets(), title: document.title });
      return;
    }
    if (message?.type === "showit-pick-privacy-mask") {
      pickMaskElement(sendResponse);
      return true;
    }
    if (message?.type === "showit-cancel-privacy-mask") {
      maskPicker?.();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "showit-resolve-privacy-masks") {
      sendResponse({ ok: true, ...resolvePrivacyMasks(message.items) });
    }
  });
}
