import { describe, expect, it, vi } from "vitest";
import { startExtensionProbe, type ExtensionProbeState } from "./connector-probe";

describe("extension connector probe", () => {
  it("reports an actionable error when there are no receivers", async () => {
    const states: ExtensionProbeState[] = [];
    startExtensionProbe(async () => 0, (state) => states.push(state));
    await Promise.resolve();
    expect(states).toEqual([
      { state: "loading" },
      { state: "error", reason: expect.stringContaining("扩展未连接") }
    ]);
  });

  it("times out when a connected receiver never responds", async () => {
    vi.useFakeTimers();
    const states: ExtensionProbeState[] = [];
    startExtensionProbe(async () => 1, (state) => states.push(state), 50);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);
    expect(states.at(-1)).toEqual({ state: "error", reason: expect.stringContaining("响应超时") });
    vi.useRealTimers();
  });

  it("times out when the native probe call itself never resolves", async () => {
    vi.useFakeTimers();
    const states: ExtensionProbeState[] = [];
    startExtensionProbe(() => new Promise<number>(() => undefined), (state) => states.push(state), 50);
    expect(states).toEqual([{ state: "loading" }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(states.at(-1)).toEqual({ state: "error", reason: expect.stringContaining("响应超时") });
    vi.useRealTimers();
  });

  it("cancels the timeout after a probe response", async () => {
    vi.useFakeTimers();
    const states: ExtensionProbeState[] = [];
    const controller = startExtensionProbe(async () => 1, (state) => states.push(state), 50);
    await Promise.resolve();
    controller.settle();
    await vi.advanceTimersByTimeAsync(50);
    expect(states).toEqual([{ state: "loading" }]);
    vi.useRealTimers();
  });
});
