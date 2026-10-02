import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleProject, sampleSession } from "../lib/sample-project";
import { applyAction, autoAdvanceElapsedMs, initialMachineState, sectionElapsedMs, type MachineState } from "./machine";

function boot(project = sampleProject, session = structuredClone(sampleSession)): MachineState {
  return applyAction(initialMachineState(), { type: "set-workspace", project, session }).state;
}

describe("session machine", () => {
  let state: MachineState;

  beforeEach(() => {
    state = boot();
  });

  afterEach(() => vi.useRealTimers());

  const run = (action: Parameters<typeof applyAction>[1]) => {
    state = applyAction(state, action).state;
  };

  it("moves to a new page and hides the previous page's annotations", () => {
    run({ type: "add-circle", circle: { id: "circle-test", x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.4 } });
    run({ type: "set-active-page", index: 2 });
    expect(state.session.currentPageIndex).toBe(2);
    expect(state.session.circles).toEqual([]);
    expect(state.session.annotationTool).toBe("none");
  });

  it("restores a page's annotations when navigating back to it", () => {
    run({ type: "add-circle", circle: { id: "c1", x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.4 } });
    run({ type: "add-circle", circle: { id: "c2", x1: 0.2, y1: 0.2, x2: 0.5, y2: 0.5 } });
    run({ type: "set-active-page", index: 2 });
    expect(state.session.circles).toEqual([]);
    run({ type: "set-active-page", index: 0 });
    expect(state.session.circles.map((circle) => circle.id)).toEqual(["c1", "c2"]);
  });

  it("undoes annotations one by one in reverse order", () => {
    run({ type: "add-circle", circle: { id: "c1", x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.4 } });
    run({ type: "add-circle", circle: { id: "c2", x1: 0.2, y1: 0.2, x2: 0.5, y2: 0.5 } });
    run({ type: "add-circle", circle: { id: "c3", x1: 0.3, y1: 0.3, x2: 0.6, y2: 0.6 } });
    run({ type: "undo-annotation" });
    expect(state.session.circles.map((circle) => circle.id)).toEqual(["c1", "c2"]);
    // 撤销不关闭圈选工具：可以接着画，也可以接着撤销。
    run({ type: "set-annotation-tool", tool: "circle" });
    run({ type: "undo-annotation" });
    expect(state.session.circles.map((circle) => circle.id)).toEqual(["c1"]);
    expect(state.session.annotationTool).toBe("circle");
    run({ type: "undo-annotation" });
    expect(state.session.circles).toEqual([]);
  });

  it("activates offline fallback only for the current page and clears it when navigating", () => {
    run({ type: "set-offline-fallback-active", active: true });
    expect(state.session.offlineFallbackPageId).toBe(sampleProject.pages[0]?.id);
    run({ type: "set-active-page", index: 1 });
    expect(state.session.offlineFallbackPageId).toBeNull();
  });

  it("keeps one-time offline network grants in the runtime session", () => {
    const project = structuredClone(sampleProject);
    project.pages[0]!.offline = {
      kind: "html",
      content: "<img src='https://assets.example.com/image.png'>",
      allowedNetworkOrigins: []
    };
    state = boot(project);

    run({ type: "grant-offline-network-origin", origin: "https://assets.example.com" });
    run({ type: "grant-offline-network-origin", origin: "https://assets.example.com" });

    expect(state.session.offlineNetworkGrants).toEqual([
      { pageId: project.pages[0]!.id, origin: "https://assets.example.com" }
    ]);
    expect(project.pages[0]!.offline?.kind === "html" && project.pages[0]!.offline.allowedNetworkOrigins).toEqual([]);
  });

  it("persists a privacy mask on the current page without placing it in the presenter view", () => {
    run({ type: "add-privacy-mask", mask: { id: "mask-test", x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.5, mode: "blur" } });
    expect(state.project.pages[0]?.privacyMasks).toEqual([
      { id: "mask-test", x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.5, mode: "blur" }
    ]);
    run({ type: "clear-privacy-masks" });
    expect(state.project.pages[0]?.privacyMasks).toEqual([]);
  });

  it("updates bound privacy mask bounds only when the element moves", () => {
    run({ type: "add-privacy-mask", mask: { id: "mask-bound", x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.5, mode: "solid", locator: { strategy: "testid", value: "customer-email" } } });
    const before = state.session.sequence;
    run({ type: "update-privacy-mask", maskId: "mask-bound", bounds: { x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.5 } });
    expect(state.session.sequence).toBe(before);
    run({ type: "update-privacy-mask", maskId: "mask-bound", bounds: { x1: 0.2, y1: 0.2, x2: 0.5, y2: 0.5 } });
    expect(state.project.pages[0]?.privacyMasks[0]).toMatchObject({ x1: 0.2, x2: 0.5, locator: { strategy: "testid", value: "customer-email" } });
  });

  it("tracks completed steps as a toggle", () => {
    const stepId = sampleProject.pages[0]!.script.steps[0]!.id;
    run({ type: "toggle-step", stepId });
    expect(state.session.completedStepIds).toContain(stepId);
    run({ type: "toggle-step", stepId });
    expect(state.session.completedStepIds).not.toContain(stepId);
  });

  it("advances and rewinds the current page steps", () => {
    const stepId = sampleProject.pages[0]!.script.steps[0]!.id;
    run({ type: "next-step" });
    expect(state.session.completedStepIds).toContain(stepId);
    run({ type: "previous-step" });
    expect(state.session.completedStepIds).not.toContain(stepId);
  });

  it("requires explicit confirmation before completing a high-risk step", () => {
    const project = structuredClone(sampleProject);
    project.pages[0]!.script.steps[0] = { ...project.pages[0]!.script.steps[0]!, risk: "high" };
    state = boot(project);
    run({ type: "next-step" });
    expect(state.session.completedStepIds).toEqual([]);
    expect(state.session.pendingHighRiskStepId).toBe(project.pages[0]?.script.steps[0]?.id);
    run({ type: "confirm-high-risk-step" });
    expect(state.session.completedStepIds).toContain(project.pages[0]?.script.steps[0]?.id);
    expect(state.session.pendingHighRiskStepId).toBeNull();
  });

  it("completes a verified step result without toggling it back", () => {
    const stepId = sampleProject.pages[0]!.script.steps[0]!.id;
    run({ type: "complete-step", stepId });
    run({ type: "complete-step", stepId });
    expect(state.session.completedStepIds.filter((id) => id === stepId)).toHaveLength(1);
  });

  it("requires and persists a reason when a step is forcibly completed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T08:00:00Z"));
    const stepId = sampleProject.pages[0]!.script.steps[0]!.id;

    run({ type: "force-complete-step", stepId, reason: "   " });
    expect(state.session.completedStepIds).not.toContain(stepId);

    run({ type: "force-complete-step", stepId, reason: "现场系统数据尚未同步" });
    expect(state.session.forcedStepCompletions).toEqual([
      { stepId, reason: "现场系统数据尚未同步", at: Date.now() }
    ]);
    expect(state.session.completedStepIds).toContain(stepId);

    run({ type: "toggle-step", stepId });
    expect(state.session.forcedStepCompletions).toEqual([]);
  });

  it("moves between pages after the last step and when rewinding", () => {
    const first = sampleProject.pages[0]!;
    for (const _step of first.script.steps) run({ type: "next-step" });
    run({ type: "next-step" });
    expect(state.session.currentPageIndex).toBe(1);
    run({ type: "previous-step" });
    expect(state.session.currentPageIndex).toBe(0);
    expect(state.session.completedStepIds).not.toContain(first.script.steps.at(-1)?.id);
  });

  it("starts, pauses and resets the timer state", () => {
    run({ type: "start-timer" });
    expect(state.session.timerStatus).toBe("running");
    run({ type: "pause-timer" });
    expect(state.session.timerStatus).toBe("paused");
    run({ type: "reset-timer" });
    expect(state.session).toMatchObject({
      timerStatus: "idle",
      totalElapsedMs: 0,
      pageElapsedMs: 0,
      sectionElapsedMs: 0,
      autoAdvanceElapsedMs: 0,
      autoAdvanceStartedAt: null
    });
  });

  it("keeps chapter time within a section and resets it across sections", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T01:00:00Z"));
    run({ type: "start-timer" });
    vi.advanceTimersByTime(5_000);
    run({ type: "set-active-page", index: 1 });
    expect(state.session.sectionElapsedMs).toBe(5_000);

    vi.advanceTimersByTime(3_000);
    run({ type: "set-active-page", index: 2 });
    expect(state.session).toMatchObject({ totalElapsedMs: 8_000, sectionElapsedMs: 0 });

    vi.advanceTimersByTime(2_000);
    expect(sectionElapsedMs(state.session, Date.now())).toBe(2_000);
  });

  it("pauses and resumes the automatic-advance clock independently", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T02:00:00Z"));
    run({ type: "start-timer" });
    run({ type: "set-auto-advance-running", running: true });
    vi.advanceTimersByTime(5_000);
    run({ type: "set-auto-advance-running", running: false });
    expect(autoAdvanceElapsedMs(state.session, Date.now())).toBe(5_000);

    vi.advanceTimersByTime(10_000);
    expect(autoAdvanceElapsedMs(state.session, Date.now())).toBe(5_000);
    run({ type: "set-auto-advance-running", running: true });
    vi.advanceTimersByTime(2_000);
    expect(autoAdvanceElapsedMs(state.session, Date.now())).toBe(7_000);

    run({ type: "set-active-page", index: 1 });
    expect(state.session).toMatchObject({ autoAdvanceElapsedMs: 0, autoAdvanceStartedAt: null });
  });

  it("updates the global and current-page automatic advance intervals", () => {
    run({ type: "set-auto-advance-seconds", seconds: 75.4 });
    expect(state.project.autoAdvanceSeconds).toBe(75);
    run({ type: "set-current-page-auto-advance-seconds", seconds: 35.8 });
    expect(state.project.pages[0]?.autoAdvanceSeconds).toBe(36);
    run({ type: "set-current-page-auto-advance-seconds", seconds: undefined });
    expect(state.project.pages[0]?.autoAdvanceSeconds).toBeUndefined();
  });

  it("switches the browser profile for the current presentation only", () => {
    expect(state.project.browserSessionMode).toBe("daily");
    run({ type: "set-browser-session-mode", mode: "dedicated" });
    expect(state.session.browserSessionMode).toBe("dedicated");
    expect(state.project.browserSessionMode).toBe("daily");
  });

  it("tracks the current audience count without duplicating unchanged updates", () => {
    const initialSequence = state.session.sequence;
    run({ type: "set-audience-count", count: 3 });
    expect(state.session).toMatchObject({ audienceStatus: "synced", audienceCount: 3 });
    const syncedSequence = state.session.sequence;
    expect(syncedSequence).toBe(initialSequence + 1);
    run({ type: "set-audience-count", count: 3 });
    expect(state.session.sequence).toBe(syncedSequence);
    run({ type: "set-audience-count", count: 0 });
    expect(state.session).toMatchObject({ audienceStatus: "connecting", audienceCount: 0 });
  });

  it("counts the local audience window without the viewer poll marking it disconnected", () => {
    run({ type: "audience-ready" });
    expect(state.localAudience).toBe(true);
    expect(state.session.audienceStatus).toBe("synced");
    run({ type: "set-audience-count", count: 0 });
    expect(state.session).toMatchObject({ audienceStatus: "synced", audienceCount: 0 });
    run({ type: "set-audience-count", count: 2 });
    expect(state.session).toMatchObject({ audienceStatus: "synced", audienceCount: 2 });
    run({ type: "audience-disconnected" });
    expect(state.session).toMatchObject({ audienceStatus: "synced", audienceCount: 0 });
    run({ type: "local-audience-closed" });
    expect(state.localAudience).toBe(false);
    expect(state.session).toMatchObject({ audienceStatus: "disconnected", audienceCount: 0 });
    run({ type: "set-audience-count", count: 0 });
    expect(state.session.audienceStatus).toBe("connecting");
  });

  it("records planned and actual time for a rehearsal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T00:00:00Z"));
    run({ type: "start-rehearsal" });
    vi.advanceTimersByTime(5_000);
    run({ type: "set-active-page", index: 1 });
    vi.advanceTimersByTime(3_000);
    const { state: next, rehearsal } = applyAction(state, { type: "finish-rehearsal", note: "  开场偏慢  " });

    expect(rehearsal?.totalElapsedMs).toBe(8_000);
    expect(rehearsal?.pages[0]?.actualMs).toBe(5_000);
    expect(rehearsal?.pages[1]?.actualMs).toBe(3_000);
    expect(rehearsal?.note).toBe("开场偏慢");
    expect(next.rehearsalStartedAt).toBeNull();
  });

  it("tracks presenter edits per page and field, and clears them on exit or workspace swap", () => {
    run({ type: "update-script", markdown: "现场脚本" });
    run({ type: "set-active-page", index: 1 });
    run({ type: "add-privacy-mask", mask: { id: "mask-edit", x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.5, mode: "blur" } });
    run({ type: "set-stage-percent", stagePercent: 60 });
    run({ type: "set-auto-advance", enabled: true });

    expect(state.presenterEdits).toEqual({
      pageEdits: {
        [sampleProject.pages[0]!.id]: ["script"],
        [sampleProject.pages[1]!.id]: ["masks"]
      },
      projectEdits: ["layout", "autoAdvance"]
    });

    run({ type: "set-workspace", project: sampleProject, session: structuredClone(sampleSession) });
    expect(state.presenterEdits).toEqual({ pageEdits: {}, projectEdits: [] });

    run({ type: "update-script", markdown: "再次修改" });
    expect(state.presenterEdits.pageEdits[sampleProject.pages[0]!.id]).toEqual(["script"]);
    run({ type: "end-presentation" });
    expect(state.presenterEdits).toEqual({ pageEdits: {}, projectEdits: [] });
  });
});
