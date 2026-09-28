export type ElementLocatorLike = {
  strategy?: unknown;
  value?: unknown;
};

const sensitivePattern = /(password|passwd|secret|token|cookie|authorization|credential|api[-_]?key)/i;
const locatorStrategies = new Set(["testid", "id", "aria", "role"]);
const inputSources = new Set(["project", "page", "sensitive"]);

type Locator = { strategy: string; value: string };
type InputSource = { source: string; value?: unknown; key?: unknown };

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isLocatorShaped(value: unknown): value is Record<string, unknown> & Locator {
  return Boolean(value && typeof value === "object");
}

export function isValidLocator(locator: unknown): boolean {
  if (!isLocatorShaped(locator)) return false;
  return Boolean(
    hasOnlyKeys(locator, ["strategy", "value"])
    && locatorStrategies.has(locator.strategy as string)
    && isBoundedText(locator.value, 200)
    && !sensitivePattern.test(locator.value as string)
  );
}

export function isValidInputLocator(locator: unknown): boolean {
  if (!isLocatorShaped(locator)) return false;
  return Boolean(
    hasOnlyKeys(locator, ["strategy", "value"])
    && locatorStrategies.has(locator.strategy as string)
    && isBoundedText(locator.value, 200)
  );
}

function isValidInputSource(input: unknown): input is InputSource {
  if (!input || typeof input !== "object") return false;
  const candidate = input as Record<string, unknown>;
  if (candidate.source === "fixed") return hasOnlyKeys(candidate, ["source", "value"]) && typeof candidate.value === "string" && (candidate.value as string).length <= 2_000;
  return inputSources.has(candidate.source as string) && hasOnlyKeys(candidate, ["source", "key"]) && isBoundedText(candidate.key, 80) && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(candidate.key as string);
}

function isAllowedUrl(value: unknown): value is string {
  try {
    const url = new URL(value as string);
    if (url.username || url.password || [...url.searchParams.keys()].some((key) => sensitivePattern.test(key))) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

type ActionLike = { type?: unknown } & Record<string, unknown>;

export function isValidRecordedAction(action: unknown): boolean {
  if (!action || typeof action !== "object") return false;
  const candidate = action as ActionLike;
  if (candidate.type === "click" || candidate.type === "focus") {
    return hasOnlyKeys(candidate, ["type", "locator", "label"]) && isValidLocator(candidate.locator) && (candidate.label === undefined || (typeof candidate.label === "string" && candidate.label.length <= 160));
  }
  if (candidate.type === "scroll") return hasOnlyKeys(candidate, ["type", "x", "y"]) && Number.isInteger(candidate.x) && (candidate.x as number) >= 0 && (candidate.x as number) <= 10_000_000 && Number.isInteger(candidate.y) && (candidate.y as number) >= 0 && (candidate.y as number) <= 10_000_000;
  if (candidate.type === "fill") return hasOnlyKeys(candidate, ["type", "locator", "input", "label"]) && isValidInputLocator(candidate.locator) && isValidInputSource(candidate.input) && (candidate.label === undefined || (typeof candidate.label === "string" && candidate.label.length <= 160));
  return candidate.type === "navigate" && hasOnlyKeys(candidate, ["type", "url"]) && isAllowedUrl(candidate.url);
}

export function isValidExecutionAction(action: unknown): boolean {
  if (!action || typeof action !== "object") return false;
  const candidate = action as ActionLike;
  if (candidate.type === "fill") {
    return hasOnlyKeys(candidate, ["type", "locator", "value", "label"])
      && isValidInputLocator(candidate.locator)
      && typeof candidate.value === "string"
      && (candidate.value as string).length <= 2_000
      && (candidate.label === undefined || (typeof candidate.label === "string" && candidate.label.length <= 160));
  }
  return isValidRecordedAction(action);
}

export function isValidExpectedCondition(condition: unknown): boolean {
  if (condition === undefined || condition === null) return true;
  if (!condition || typeof condition !== "object") return false;
  const candidate = condition as ActionLike;
  if (candidate.type === "element") return hasOnlyKeys(candidate, ["type", "locator"]) && isValidLocator(candidate.locator);
  if (candidate.type === "url") return hasOnlyKeys(candidate, ["type", "value"]) && isAllowedUrl(candidate.value);
  return (candidate.type === "title" || candidate.type === "text") && hasOnlyKeys(candidate, ["type", "value"]) && isBoundedText(candidate.value, 300);
}

export function isValidStepExecution(value: unknown): value is "hint" | "highlight" | "assist" | "auto" {
  return ["hint", "highlight", "assist", "auto"].includes(value as string);
}

export function normalizeMaskRect(rect: { left?: number; top?: number; right?: number; bottom?: number } | null | undefined, viewportWidth: number, viewportHeight: number): { x1: number; y1: number; x2: number; y2: number } {
  const width = Math.max(1, Number(viewportWidth) || 0);
  const height = Math.max(1, Number(viewportHeight) || 0);
  const clamp = (value: number | undefined, size: number) => Math.max(0, Math.min(1, Number(value ?? 0) / size));
  return { x1: clamp(rect?.left, width), y1: clamp(rect?.top, height), x2: clamp(rect?.right, width), y2: clamp(rect?.bottom, height) };
}
