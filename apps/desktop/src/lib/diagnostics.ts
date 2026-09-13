import { downloadTextFile, redactSensitiveText } from "./export";
import { invoke } from "@tauri-apps/api/core";

const storageKey = "showit:diagnostics:v1";
const retentionMs = 7 * 24 * 60 * 60 * 1_000;
const maxEntries = 500;

export type DiagnosticEntry = {
  traceId: string;
  at: number;
  area: string;
  message: string;
};

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function redactDiagnosticText(value: string): string {
  const redacted = redactSensitiveText(value);
  return redacted.replace(/https?:\/\/[^\s"')]+/gi, "[REDACTED_URL]");
}

function readEntries(): DiagnosticEntry[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(value)) return [];
    const threshold = Date.now() - retentionMs;
    return value.filter((entry): entry is DiagnosticEntry => Boolean(entry) && typeof entry === "object" && typeof (entry as DiagnosticEntry).traceId === "string" && typeof (entry as DiagnosticEntry).at === "number" && (entry as DiagnosticEntry).at >= threshold && typeof (entry as DiagnosticEntry).area === "string" && typeof (entry as DiagnosticEntry).message === "string").slice(0, maxEntries);
  } catch {
    return [];
  }
}

function writeEntries(entries: DiagnosticEntry[]): void {
  localStorage.setItem(storageKey, JSON.stringify(entries.slice(0, maxEntries)));
}

function traceId(): string {
  const random = globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36) : Math.random().toString(36).slice(2);
  return `TRC-${Date.now().toString(36).toUpperCase()}-${random?.toUpperCase() ?? "LOCAL"}`;
}

function storeDiagnostic(entry: DiagnosticEntry): void {
  try {
    const unique = new Map([[entry.traceId, entry], ...readEntries().map((item) => [item.traceId, item] as const)]);
    writeEntries([...unique.values()].sort((left, right) => right.at - left.at));
  } catch {
    // Diagnostics must never interfere with the presentation itself.
  }
  if (inTauri()) void invoke("record_native_diagnostic", { entry }).catch(() => undefined);
}

export function recordDiagnostic(area: string, error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "未知本地错误";
  const entry: DiagnosticEntry = { traceId: traceId(), at: Date.now(), area: area.slice(0, 80), message: redactDiagnosticText(message).slice(0, 1_000) };
  storeDiagnostic(entry);
  return entry.traceId;
}

export function recordExternalDiagnostic(value: unknown, areaPrefix = "外部组件"): string | null {
  if (!isDiagnosticEntry(value)) return null;
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(value.traceId) || value.at <= 0 || value.at > Date.now() + 60_000) return null;
  const area = `${areaPrefix}：${value.area}`.slice(0, 80);
  const message = redactDiagnosticText(value.message).slice(0, 1_000);
  if (!area.trim() || !message) return null;
  storeDiagnostic({ traceId: value.traceId, at: value.at, area, message });
  return value.traceId;
}

export function listDiagnostics(): DiagnosticEntry[] {
  return readEntries();
}

export function clearDiagnostics(): void {
  localStorage.removeItem(storageKey);
  if (inTauri()) void invoke("clear_native_diagnostics").catch(() => undefined);
}

function isDiagnosticEntry(value: unknown): value is DiagnosticEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as DiagnosticEntry;
  return typeof entry.traceId === "string" && typeof entry.at === "number" && typeof entry.area === "string" && typeof entry.message === "string";
}

export async function listAllDiagnostics(): Promise<DiagnosticEntry[]> {
  const entries = listDiagnostics();
  if (!inTauri()) return entries;
  try {
    const native = await invoke<unknown[]>("list_native_diagnostics");
    const unique = new Map(entries.map((entry) => [entry.traceId, entry]));
    for (const entry of native.filter(isDiagnosticEntry)) unique.set(entry.traceId, entry);
    return [...unique.values()].sort((left, right) => right.at - left.at).slice(0, maxEntries);
  } catch {
    return entries;
  }
}

export async function downloadDiagnostics(): Promise<void> {
  const entries = await listAllDiagnostics();
  const content = JSON.stringify({ generatedAt: new Date().toISOString(), retentionDays: 7, contents: ["已脱敏运行时诊断", "已脱敏桌面本机服务诊断"], entries }, null, 2);
  downloadTextFile(`showit-diagnostics-${Date.now()}.json`, content, "application/json;charset=utf-8");
}
