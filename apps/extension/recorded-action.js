const sensitivePattern = /(password|passwd|secret|token|cookie|authorization|credential|api[-_]?key)/i;
const locatorStrategies = new Set(["testid", "id", "aria", "role"]);
const inputSources = new Set(["project", "page", "sensitive"]);

function isBoundedText(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function isValidLocator(locator) {
  return Boolean(
    locator
    && typeof locator === "object"
    && hasOnlyKeys(locator, ["strategy", "value"])
    && locatorStrategies.has(locator.strategy)
    && isBoundedText(locator.value, 200)
    && !sensitivePattern.test(locator.value)
  );
}

export function isValidInputLocator(locator) {
  return Boolean(
    locator
    && typeof locator === "object"
    && hasOnlyKeys(locator, ["strategy", "value"])
    && locatorStrategies.has(locator.strategy)
    && isBoundedText(locator.value, 200)
  );
}

function isValidInputSource(input) {
  if (!input || typeof input !== "object") return false;
  if (input.source === "fixed") return hasOnlyKeys(input, ["source", "value"]) && typeof input.value === "string" && input.value.length <= 2_000;
  return inputSources.has(input.source) && hasOnlyKeys(input, ["source", "key"]) && isBoundedText(input.key, 80) && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(input.key);
}

function isAllowedUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || [...url.searchParams.keys()].some((key) => sensitivePattern.test(key))) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

export function isValidRecordedAction(action) {
  if (!action || typeof action !== "object") return false;
  if (action.type === "click" || action.type === "focus") {
    return hasOnlyKeys(action, ["type", "locator", "label"]) && isValidLocator(action.locator) && (action.label === undefined || (typeof action.label === "string" && action.label.length <= 160));
  }
  if (action.type === "scroll") return hasOnlyKeys(action, ["type", "x", "y"]) && Number.isInteger(action.x) && action.x >= 0 && action.x <= 10_000_000 && Number.isInteger(action.y) && action.y >= 0 && action.y <= 10_000_000;
  if (action.type === "fill") return hasOnlyKeys(action, ["type", "locator", "input", "label"]) && isValidInputLocator(action.locator) && isValidInputSource(action.input) && (action.label === undefined || (typeof action.label === "string" && action.label.length <= 160));
  return action.type === "navigate" && hasOnlyKeys(action, ["type", "url"]) && isAllowedUrl(action.url);
}

export function isValidExecutionAction(action) {
  if (!action || typeof action !== "object") return false;
  if (action.type === "fill") {
    return hasOnlyKeys(action, ["type", "locator", "value", "label"])
      && isValidInputLocator(action.locator)
      && typeof action.value === "string"
      && action.value.length <= 2_000
      && (action.label === undefined || (typeof action.label === "string" && action.label.length <= 160));
  }
  return isValidRecordedAction(action);
}

export function isValidExpectedCondition(condition) {
  if (condition === undefined || condition === null) return true;
  if (!condition || typeof condition !== "object") return false;
  if (condition.type === "element") return hasOnlyKeys(condition, ["type", "locator"]) && isValidLocator(condition.locator);
  if (condition.type === "url") return hasOnlyKeys(condition, ["type", "value"]) && isAllowedUrl(condition.value);
  return (condition.type === "title" || condition.type === "text") && hasOnlyKeys(condition, ["type", "value"]) && isBoundedText(condition.value, 300);
}

export function isValidStepExecution(value) {
  return ["hint", "highlight", "assist", "auto"].includes(value);
}

export function normalizeMaskRect(rect, viewportWidth, viewportHeight) {
  const width = Math.max(1, Number(viewportWidth) || 0);
  const height = Math.max(1, Number(viewportHeight) || 0);
  const clamp = (value, size) => Math.max(0, Math.min(1, Number(value) / size));
  return { x1: clamp(rect?.left, width), y1: clamp(rect?.top, height), x2: clamp(rect?.right, width), y2: clamp(rect?.bottom, height) };
}
