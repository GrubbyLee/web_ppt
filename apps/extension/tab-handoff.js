export function captureHandoffDecision(currentTabId, nextTabId, nextUrl, originGranted) {
  if (!Number.isInteger(nextTabId) || nextTabId <= 0 || nextTabId === currentTabId) return "ignore";
  try {
    const url = new URL(nextUrl);
    const safeOrigin = url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    if (!safeOrigin) return "block";
  } catch {
    return "block";
  }
  return originGranted ? "handoff" : "authorize";
}
