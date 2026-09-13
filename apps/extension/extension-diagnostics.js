export function redactExtensionDiagnostic(value) {
  const text = String(value || "未知扩展错误").replace(/[\u0000-\u001f\u007f]/g, " ");
  const sensitiveName = "authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[-_ ]?secret|(?:access|id|refresh)?[-_ ]?token|api[-_ ]?key";
  const redacted = text
    .replace(new RegExp(`\\b(${sensitiveName})\\b\\s*:\\s*[^\\r\\n]+`, "gi"), "$1: [REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "[REDACTED_CREDENTIAL]")
    .replace(new RegExp(`([?&](?:${sensitiveName})=)[^&#\\s]+`, "gi"), "$1[REDACTED]")
    .replace(new RegExp(`\\b(${sensitiveName})\\b["']?(\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|\\x60[^\\x60]*\\x60|[^\\s,;}&]+)`, "gi"), "$1$2[REDACTED]");
  return redacted.replace(/https?:\/\/[^\s"')]+/gi, "[REDACTED_URL]").replace(/\s+/g, " ").trim().slice(0, 1000) || "未知扩展错误";
}
