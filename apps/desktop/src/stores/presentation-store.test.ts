import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleProject, sampleSession } from "../lib/sample-project";
import { autoAdvanceElapsedMs, sectionElapsedMs, usePresentationStore } from "./presentation-store";

describe("presentation store", () => {
  beforeEach(() => {
    usePresentationStore.getState().setWorkspace(sampleProject, { ...sampleSession });
  });

  afterEach(() => vi.useRealTimers());

  it("moves to a new page and clears page-local annotations", () => {
    const store = usePresentationStore.getState();
    store.addCircle({ id: "circle-test", x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.4 });
    store.setActivePage(2);
    const session = usePresentationStore.getState().session;
    expect(session.currentPageIndex).toBe(2);
    expect(session.circles).toEqual([]);
    expect(session.annotationTool).toBe("none");
  });

  it("activates offline fallback only for the current page and clears it when navigating", () => {
    const store = usePresentationStore.getState();
    store.setOfflineFallbackActive(true);
    expect(usePresentationStore.getState().session.offlineFallbackPageId).toBe(sampleProject.pages[0]?.id);
    store.setActivePage(1);
    expect(usePresentationStore.getState().session.offlineFallbackPageId).toBeNull();
  });

  it("keeps one-time offline network grants in the runtime session", () => {
    const project = structuredClone(sampleProject);
    project.pages[0]!.offline = {
      kind: "html",
      content: "<img src='https://assets.example.com/image.png'>",
      allowedNetworkOrigins: []
    };
    usePresentationStore.getState().setWorkspace(project, structuredClone(sampleSession));

    usePresentationStore.getState().grantOfflineNetworkOrigin("https://assets.example.com");
    usePresentationStore.getState().grantOfflineNetworkOrigin("https://assets.example.com");

    const state = usePresentationStore.getState();
    expect(state.session.offlineNetworkGrants).toEqual([
      { pageId: project.pages[0]!.id, origin: "https://assets.example.com" }
    ]);
    expect(state.project.pages[0]!.offline?.kind === "html" && state.project.pages[0]!.offline.allowedNetworkOrigins).toEqual([]);
  });

  it("persists a privacy mask on the current page without placing it in the presenter view", () => {
    usePresentationStore.getState().addPrivacyMask({ id: "mask-test", x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.5, mode: "blur" });
    expect(usePresentationStore.getState().project.pages[0]?.privacyMasks).toEqual([
      { id: "mask-test", x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.5, mode: "blur" }
    ]);
    usePresentationStore.getState().clearPrivacyMasks();
    expect(usePresentationStore.getState().project.pages[0]?.privacyMasks).toEqual([]);
  });

  it("updates bound privacy mask bounds only when the element moves", () => {
    usePresentationStore.getState().addPrivacyMask({ id: "mask-bound", x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.5, mode: "solid", locator: { strategy: "testid", value: "customer-email" } });
    const before = usePresentationStore.getState().session.sequence;
    usePresentationStore.getState().updatePrivacyMask("mask-bound", { x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.5 });
    expect(usePresentationStore.getState().session.sequence).toBe(before);
    usePresentationStore.getState().updatePrivacyMask("mask-bound", { x1: 0.2, y1: 0.2, x2: 0.5, y2: 0.5 });
    expect(usePresentationStore.getState().project.pages[0]?.privacyMasks[0]).toMatchObject({ x1: 0.2, x2: 0.5, locator: { strategy: "testid", value: "customer-email" } });
  });

  it("tracks completed steps as a toggle", () => {
    const stepId = sampleProject.pages[0]!.script.steps[0]!.id;
    usePresentationStore.getState().toggleStep(stepId);
    expect(usePresentationStore.getState().session.completedStepIds).toContain(stepId);
    usePresentationStore.getState().toggleStep(stepId);
    expect(usePresentationStore.getState().session.completedStepIds).not.toContain(stepId);
  });

  it("advances and rewinds the current page steps", () => {
    const stepId = sampleProject.pages[0]!.script.steps[0]!.id;
    usePresentationStore.getState().nextStep();
    expect(usePresentationStore.getState().session.completedStepIds).toContain(stepId);
    usePresentationStore.getState().previousStep();
    expect(usePresentationStore.getState().session.completedStepIds).not.toContain(stepId);
  });

  it("requires explicit confirmation before completing a high-risk step", () => {
    const project = structuredClone(sampleProject);
    project.pages[0]!.script.steps[0] = { ...project.pages[0]!.script.steps[0]!, risk: "high" };
    usePresentationStore.getState().setWorkspace(project, { ...sampleSession });
    usePresentationStore.getState().nextStep();
    expect(usePresentationStore.getState().session.completedStepIds).toEqual([]);
    expect(usePresentationStore.getState().session.pendingHighRiskStepId).toBe(project.pages[0]?.script.steps[0]?.id);
    usePresentationStore.getState().confirmHighRiskStep();
    expect(usePresentationStore.getState().session.completedStepIds).toContain(project.pages[0]?.script.steps[0]?.id);
    expect(usePresentationStore.getState().session.pendingHighRiskStepId).toBeNull();
  });

  it("completes a verified step result without toggling it back", () => {
    const stepId = sampleProject.pages[0]!.script.steps[0]!.id;
    usePresentationStore.getState().completeStep(stepId);
    usePresentationStore.getState().completeStep(stepId);
    expect(usePresentationStore.getState().session.completedStepIds.filter((id) => id === stepId)).toHaveLength(1);
  });

  it("requires and persists a reason when a step is forcibly completed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T08:00:00Z"));
    const stepId = sampleProject.pages[0]!.script.steps[0]!.id;

    usePresentationStore.getState().forceCompleteStep(stepId, "   ");
    expect(usePresentationStore.getState().session.completedStepIds).not.toContain(stepId);

    usePresentationStore.getState().forceCompleteStep(stepId, "现场系统数据尚未同步");
    expect(usePresentationStore.getState().session.forcedStepCompletions).toEqual([
      { stepId, reason: "现场系统数据尚未同步", at: Date.now() }
    ]);
    expect(usePresentationStore.getState().session.completedStepIds).toContain(stepId);

    usePresentationStore.getState().toggleStep(stepId);
    expect(usePresentationStore.getState().session.forcedStepCompletions).toEqual([]);
  });

  it("moves between pages after the last step and when rewinding", () => {
    const store = usePresentationStore.getState();
    const first = sampleProject.pages[0]!;
    for (const _step of first.script.steps) store.nextStep();
    store.nextStep();
    expect(usePresentationStore.getState().session.currentPageIndex).toBe(1);
    usePresentationStore.getState().previousStep();
    expect(usePresentationStore.getState().session.currentPageIndex).toBe(0);
    expect(usePresentationStore.getState().session.completedStepIds).not.toContain(first.script.steps.at(-1)?.id);
  });

  it("starts, pauses and resets the timer state", () => {
    usePresentationStore.getState().startTimer();
    expect(usePresentationStore.getState().session.timerStatus).toBe("running");
    usePresentationStore.getState().pauseTimer();
    expect(usePresentationStore.getState().session.timerStatus).toBe("paused");
    usePresentationStore.getState().resetTimer();
    expect(usePresentationStore.getState().session).toMatchObject({
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
    usePresentationStore.getState().startTimer();
    vi.advanceTimersByTime(5_000);
    usePresentationStore.getState().setActivePage(1);
    expect(usePresentationStore.getState().session.sectionElapsedMs).toBe(5_000);

    vi.advanceTimersByTime(3_000);
    usePresentationStore.getState().setActivePage(2);
    expect(usePresentationStore.getState().session).toMatchObject({ totalElapsedMs: 8_000, sectionElapsedMs: 0 });

    vi.advanceTimersByTime(2_000);
    expect(sectionElapsedMs(usePresentationStore.getState().session, Date.now())).toBe(2_000);
  });

  it("pauses and resumes the automatic-advance clock independently", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T02:00:00Z"));
    usePresentationStore.getState().startTimer();
    usePresentationStore.getState().setAutoAdvanceRunning(true);
    vi.advanceTimersByTime(5_000);
    usePresentationStore.getState().setAutoAdvanceRunning(false);
    expect(autoAdvanceElapsedMs(usePresentationStore.getState().session, Date.now())).toBe(5_000);

    vi.advanceTimersByTime(10_000);
    expect(autoAdvanceElapsedMs(usePresentationStore.getState().session, Date.now())).toBe(5_000);
    usePresentationStore.getState().setAutoAdvanceRunning(true);
    vi.advanceTimersByTime(2_000);
    expect(autoAdvanceElapsedMs(usePresentationStore.getState().session, Date.now())).toBe(7_000);

    usePresentationStore.getState().setActivePage(1);
    expect(usePresentationStore.getState().session).toMatchObject({ autoAdvanceElapsedMs: 0, autoAdvanceStartedAt: null });
  });

  it("updates the global and current-page automatic advance intervals", () => {
    usePresentationStore.getState().setAutoAdvanceSeconds(75.4);
    expect(usePresentationStore.getState().project.autoAdvanceSeconds).toBe(75);
    usePresentationStore.getState().setCurrentPageAutoAdvanceSeconds(35.8);
    expect(usePresentationStore.getState().project.pages[0]?.autoAdvanceSeconds).toBe(36);
    usePresentationStore.getState().setCurrentPageAutoAdvanceSeconds(undefined);
    expect(usePresentationStore.getState().project.pages[0]?.autoAdvanceSeconds).toBeUndefined();
  });

  it("switches the browser profile for the current presentation only", () => {
    expect(usePresentationStore.getState().project.browserSessionMode).toBe("daily");
    usePresentationStore.getState().setBrowserSessionMode("dedicated");
    expect(usePresentationStore.getState().session.browserSessionMode).toBe("dedicated");
    expect(usePresentationStore.getState().project.browserSessionMode).toBe("daily");
  });

  it("tracks the current LAN audience count without duplicating unchanged updates", () => {
    const initialSequence = usePresentationStore.getState().session.sequence;
    usePresentationStore.getState().setAudienceCount(3);
    expect(usePresentationStore.getState().session).toMatchObject({ audienceStatus: "synced", audienceCount: 3 });
    const syncedSequence = usePresentationStore.getState().session.sequence;
    expect(syncedSequence).toBe(initialSequence + 1);
    usePresentationStore.getState().setAudienceCount(3);
    expect(usePresentationStore.getState().session.sequence).toBe(syncedSequence);
    usePresentationStore.getState().setAudienceCount(0);
    expect(usePresentationStore.getState().session).toMatchObject({ audienceStatus: "connecting", audienceCount: 0 });
  });

  it("records planned and actual time for a rehearsal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T00:00:00Z"));
    usePresentationStore.getState().startRehearsal();
    vi.advanceTimersByTime(5_000);
    usePresentationStore.getState().setActivePage(1);
    vi.advanceTimersByTime(3_000);
    const rehearsal = usePresentationStore.getState().finishRehearsal();

    expect(rehearsal?.totalElapsedMs).toBe(8_000);
    expect(rehearsal?.pages[0]?.actualMs).toBe(5_000);
    expect(rehearsal?.pages[1]?.actualMs).toBe(3_000);
    expect(usePresentationStore.getState().rehearsalStartedAt).toBeNull();
  });
});
