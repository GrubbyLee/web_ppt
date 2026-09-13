import { afterEach, describe, expect, it } from "vitest";
import { clearDiagnostics, listAllDiagnostics, listDiagnostics, recordDiagnostic, recordExternalDiagnostic } from "./diagnostics";

describe("local diagnostics", () => {
  afterEach(() => clearDiagnostics());

  it("assigns a trace ID and redacts secrets and business URLs", () => {
    const traceId = recordDiagnostic("业务连接", '"token":"hunter2" https://example.com/app/customer/42?token=secret-value');
    const entry = listDiagnostics()[0];
    expect(traceId).toMatch(/^TRC-/);
    expect(entry?.message).toContain("token:[REDACTED]");
    expect(entry?.message).toContain("[REDACTED_URL]");
    expect(entry?.message).not.toContain("example.com");
    expect(entry?.message).not.toContain("customer/42");
    expect(entry?.message).not.toContain("secret-value");
  });

  it("returns browser diagnostics when no desktop runtime is available", async () => {
    recordDiagnostic("本机测试", "连接失败");
    await expect(listAllDiagnostics()).resolves.toHaveLength(1);
  });

  it("preserves and deduplicates external diagnostic trace IDs", () => {
    const entry = { traceId: "EXT-TEST-1", at: Date.now(), area: "捕获业务标签", message: "token=secret-value https://example.com/path?q=private" };
    expect(recordExternalDiagnostic(entry, "浏览器扩展")).toBe(entry.traceId);
    expect(recordExternalDiagnostic(entry, "浏览器扩展")).toBe(entry.traceId);
    expect(listDiagnostics()).toEqual([
      expect.objectContaining({ traceId: entry.traceId, area: "浏览器扩展：捕获业务标签", message: "token=[REDACTED] [REDACTED_URL]" })
    ]);
  });

  it("rejects malformed external diagnostics", () => {
    expect(recordExternalDiagnostic({ traceId: "invalid trace id", at: Date.now(), area: "扩展", message: "错误" })).toBeNull();
    expect(listDiagnostics()).toEqual([]);
  });
});
