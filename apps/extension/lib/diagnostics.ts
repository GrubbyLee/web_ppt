import { downloadTextFile, redactSensitiveText } from "./export";
import { kvGet, kvRemove, kvSet } from "./kv";

const storageKey = "showit:diagnostics:v1";
const retentionMs = 7 * 24 * 60 * 60 * 1_000;
const maxEntries = 500;

export type DiagnosticEntry = {
  traceId: string;
  at: number;
  area: string;
  message: string;
};

function redactDiagnosticText(value: string): string {
  const redacted = redactSensitiveText(value);
  return redacted.replace(/https?:\/\/[^\s"')]+/gi, "[REDACTED_URL]");
}

function isValidEntry(value: unknown): value is DiagnosticEntry {
  return Boolean(value) && typeof value === "object"
    && typeof (value as DiagnosticEntry).traceId === "string"
    && typeof (value as DiagnosticEntry).at === "number"
    && typeof (value as DiagnosticEntry).area === "string"
    && typeof (value as DiagnosticEntry).message === "string";
}

async function readEntries(): Promise<DiagnosticEntry[]> {
  const threshold = Date.now() - retentionMs;
  const stored = await kvGet<unknown[]>(storageKey);
  return (Array.isArray(stored) ? stored : [])
    .filter(isValidEntry)
    .filter((entry) => entry.at >= threshold)
    .slice(0, maxEntries);
}

function traceId(): string {
  const random = globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36) : Math.random().toString(36).slice(2);
  return `TRC-${Date.now().toString(36).toUpperCase()}-${random?.toUpperCase() ?? "LOCAL"}`;
}

async function storeDiagnostic(entry: DiagnosticEntry): Promise<void> {
  try {
    const unique = new Map([[entry.traceId, entry], ...(await readEntries()).map((item) => [item.traceId, item] as const)]);
    await kvSet(storageKey, [...unique.values()].sort((left, right) => right.at - left.at));
  } catch {
    // Diagnostics must never interfere with the presentation itself.
  }
}

export function recordDiagnostic(area: string, error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "未知本地错误";
  const entry: DiagnosticEntry = { traceId: traceId(), at: Date.now(), area: area.slice(0, 80), message: redactDiagnosticText(message).slice(0, 1_000) };
  void storeDiagnostic(entry);
  return entry.traceId;
}

export async function listDiagnostics(): Promise<DiagnosticEntry[]> {
  return readEntries();
}

export async function clearDiagnostics(): Promise<void> {
  await kvRemove(storageKey);
}

export async function downloadDiagnostics(): Promise<void> {
  const entries = await listDiagnostics();
  const content = JSON.stringify({ generatedAt: new Date().toISOString(), retentionDays: 7, contents: ["已脱敏运行时诊断"], entries }, null, 2);
  downloadTextFile(`showit-diagnostics-${Date.now()}.json`, content, "application/json;charset=utf-8");
}
