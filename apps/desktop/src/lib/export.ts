import type { PreflightReport } from "./preflight";
import type { Project, Rehearsal } from "@showit/contracts";

const sensitiveName = "authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[-_ ]?secret|(?:access|id|refresh)?[-_ ]?token|api[-_ ]?key";
const sensitiveAssignment = new RegExp(`\\b(${sensitiveName})\\b["']?(\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|\\x60[^\\x60]*\\x60|[^\\s,;}&]+)`, "gi");
const sensitiveQuery = new RegExp(`([?&](?:${sensitiveName})=)[^&#\\s]+`, "gi");
const sensitiveHeader = new RegExp(`\\b(${sensitiveName})\\b\\s*:\\s*[^\\r\\n]+`, "gi");
const credentialToken = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(sensitiveHeader, "$1: [REDACTED]")
    .replace(credentialToken, "[REDACTED_CREDENTIAL]")
    .replace(sensitiveQuery, "$1[REDACTED]")
    .replace(sensitiveAssignment, "$1$2[REDACTED]");
}

export function downloadTextFile(filename: string, content: string, type = "text/plain;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function fileSafeName(value: string): string {
  const name = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return name || "showit";
}

export function downloadMarkdownScript(project: Project, pageId: string): void {
  const page = project.pages.find((item) => item.id === pageId);
  if (!page) return;
  downloadTextFile(`${fileSafeName(project.name)}-${String(page.order + 1).padStart(2, "0")}.md`, redactSensitiveText(page.script.markdown), "text/markdown;charset=utf-8");
}

export function downloadPreflightReport(project: Project, report: PreflightReport): void {
  const content = JSON.stringify({
    generatedAt: new Date().toISOString(),
    project: { id: project.id, name: project.name, pages: project.pages.length },
    canPublish: report.canPublish,
    errors: report.errors.length,
    warnings: report.warnings.length,
    items: report.items.map(({ id, state, message, pageId }) => ({ id, state, message: redactSensitiveText(message), pageId }))
  }, null, 2);
  downloadTextFile(`${fileSafeName(project.name)}-preflight.json`, content, "application/json;charset=utf-8");
}

function csvCell(value: string | number): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function downloadRehearsalReport(project: Project, rehearsal: Rehearsal): void {
  const pageMap = new Map(project.pages.map((page) => [page.id, page]));
  const rows = [
    ["项目", redactSensitiveText(project.name)],
    ["开始时间", new Date(rehearsal.startedAt).toLocaleString("zh-CN")],
    ["结束时间", new Date(rehearsal.endedAt).toLocaleString("zh-CN")],
    ["总耗时（毫秒）", rehearsal.totalElapsedMs],
    [],
    ["页码", "页面", "计划毫秒", "实际毫秒", "差值毫秒"]
  ];
  for (const timing of rehearsal.pages) {
    const page = pageMap.get(timing.pageId);
    rows.push([
      page ? page.order + 1 : "",
      redactSensitiveText(page?.title ?? timing.pageId),
      timing.plannedMs,
      timing.actualMs,
      timing.actualMs - timing.plannedMs
    ]);
  }
  const content = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  downloadTextFile(`${fileSafeName(project.name)}-rehearsal-${rehearsal.endedAt}.csv`, content, "text/csv;charset=utf-8");
}
