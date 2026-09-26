import { create } from "zustand";
import type { Circle, PresentationSession, PrivacyMask, Project, ProjectLayout, Rehearsal, ScreenMode } from "@showit/contracts";
import { createProject, createSession } from "../lib/project-workspace";

export type SaveState = "idle" | "saving" | "saved" | "error";

type PresentationStore = {
  project: Project;
  session: PresentationSession;
  hydrated: boolean;
  saveState: SaveState;
  lastSavedAt: number | null;
  rehearsalStartedAt: number | null;
  rehearsalPageMs: Record<string, number>;
  setWorkspace: (project: Project, session: PresentationSession) => void;
  setSaveState: (state: SaveState) => void;
  setStagePercent: (stagePercent: number) => void;
  setLayoutPreset: (preset: ProjectLayout["preset"]) => void;
  setNoteFontScale: (fontScale: number) => void;
  setActivePage: (index: number) => void;
  setPageUrl: (url: string | undefined) => void;
  updateScript: (markdown: string) => void;
  toggleStep: (stepId: string) => void;
  completeStep: (stepId: string) => void;
  forceCompleteStep: (stepId: string, reason: string) => void;
  nextStep: () => void;
  previousStep: () => void;
  confirmHighRiskStep: () => void;
  cancelHighRiskStep: () => void;
  startTimer: () => void;
  pauseTimer: () => void;
  resetTimer: () => void;
  startRehearsal: () => void;
  finishRehearsal: () => Rehearsal | null;
  setAutoAdvance: (enabled: boolean) => void;
  setAutoAdvanceSeconds: (seconds: number) => void;
  setCurrentPageAutoAdvanceSeconds: (seconds: number | undefined) => void;
  setAutoAdvanceRunning: (running: boolean) => void;
  setBrowserSessionMode: (mode: PresentationSession["browserSessionMode"]) => void;
  setScreenMode: (screenMode: ScreenMode) => void;
  setOfflineFallbackActive: (active: boolean) => void;
  grantOfflineNetworkOrigin: (origin: string) => void;
  setAnnotationTool: (tool: PresentationSession["annotationTool"]) => void;
  setLaser: (laser: PresentationSession["laser"]) => void;
  addCircle: (circle: Circle) => void;
  addPrivacyMask: (mask: PrivacyMask) => void;
  updatePrivacyMask: (maskId: string, bounds: Pick<PrivacyMask, "x1" | "y1" | "x2" | "y2">) => void;
  clearPrivacyMasks: () => void;
  clearAnnotations: () => void;
  audienceReady: () => void;
  setAudienceCount: (count: number) => void;
  audienceDisconnected: () => void;
  endPresentation: () => void;
};

function withSequence(session: PresentationSession, changes: Partial<PresentationSession>): PresentationSession {
  return {
    ...session,
    ...changes,
    sequence: session.sequence + 1
  };
}

function settleTimer(session: PresentationSession, now = Date.now()): PresentationSession {
  if (session.timerStatus !== "running" || session.timerStartedAt === null) return session;
  const elapsed = Math.max(0, now - session.timerStartedAt);
  return {
    ...session,
    totalElapsedMs: session.totalElapsedMs + elapsed,
    pageElapsedMs: session.pageElapsedMs + elapsed,
    sectionElapsedMs: session.sectionElapsedMs + elapsed,
    timerStartedAt: null
  };
}

function settleAutoAdvance(session: PresentationSession, now = Date.now()): PresentationSession {
  if (session.autoAdvanceStartedAt === null) return session;
  return {
    ...session,
    autoAdvanceElapsedMs: session.autoAdvanceElapsedMs + Math.max(0, now - session.autoAdvanceStartedAt),
    autoAdvanceStartedAt: null
  };
}

function withoutForcedCompletion(session: PresentationSession, stepId: string): PresentationSession["forcedStepCompletions"] {
  return session.forcedStepCompletions.filter((completion) => completion.stepId !== stepId);
}

const presetStagePercent: Record<ProjectLayout["preset"], number> = {
  stage: 72,
  balanced: 62,
  notes: 54
};

export function elapsedMs(session: PresentationSession, total: boolean, now = Date.now()): number {
  const settled = total ? session.totalElapsedMs : session.pageElapsedMs;
  if (session.timerStatus !== "running" || session.timerStartedAt === null) return settled;
  return settled + Math.max(0, now - session.timerStartedAt);
}

export function sectionElapsedMs(session: PresentationSession, now = Date.now()): number {
  if (session.timerStatus !== "running" || session.timerStartedAt === null) return session.sectionElapsedMs;
  return session.sectionElapsedMs + Math.max(0, now - session.timerStartedAt);
}

export function autoAdvanceElapsedMs(session: PresentationSession, now = Date.now()): number {
  if (session.autoAdvanceStartedAt === null) return session.autoAdvanceElapsedMs;
  return session.autoAdvanceElapsedMs + Math.max(0, now - session.autoAdvanceStartedAt);
}

const initialProject = createProject("未命名演示");
const initialSession = createSession(initialProject);

export const usePresentationStore = create<PresentationStore>((set) => ({
  project: initialProject,
  session: initialSession,
  hydrated: false,
  saveState: "idle",
  lastSavedAt: null,
  rehearsalStartedAt: null,
  rehearsalPageMs: {},
  setWorkspace: (project, session) => set({ project, session, hydrated: true, rehearsalStartedAt: null, rehearsalPageMs: {} }),
  setSaveState: (saveState) =>
    set({
      saveState,
      lastSavedAt: saveState === "saved" ? Date.now() : null
    }),
  setStagePercent: (stagePercent) =>
    set((state) => ({
      project: {
        ...state.project,
        layout: { ...state.project.layout, stagePercent: Math.round(Math.min(75, Math.max(50, stagePercent))) }
      }
    })),
  setLayoutPreset: (preset) =>
    set((state) => ({
      project: {
        ...state.project,
        layout: {
          ...state.project.layout,
          preset,
          stagePercent: presetStagePercent[preset]
        }
      }
    })),
  setNoteFontScale: (noteFontScale) =>
    set((state) => ({
      project: {
        ...state.project,
        layout: {
          ...state.project.layout,
          noteFontScale: Math.min(1.35, Math.max(0.85, Number(noteFontScale.toFixed(2))))
        }
      }
    })),
  setActivePage: (index) =>
    set((state) => {
      const targetIndex = Math.max(0, Math.min(state.project.pages.length - 1, index));
      if (targetIndex === state.session.currentPageIndex) return state;
      const now = Date.now();
      const settled = settleAutoAdvance(settleTimer(state.session, now), now);
      const currentPage = state.project.pages[state.session.currentPageIndex];
      const targetPage = state.project.pages[targetIndex];
      const rehearsalPageMs = state.rehearsalStartedAt !== null && currentPage
        ? { ...state.rehearsalPageMs, [currentPage.id]: (state.rehearsalPageMs[currentPage.id] ?? 0) + settled.pageElapsedMs }
        : state.rehearsalPageMs;
      return {
        rehearsalPageMs,
        session: withSequence(settled, {
          currentPageIndex: targetIndex,
          pageElapsedMs: 0,
          sectionElapsedMs: currentPage?.section === targetPage?.section ? settled.sectionElapsedMs : 0,
          timerStartedAt: settled.timerStatus === "running" ? now : null,
          autoAdvanceElapsedMs: 0,
          autoAdvanceStartedAt: null,
          circles: [],
          laser: null,
          annotationTool: "none",
          offlineFallbackPageId: null,
          pendingHighRiskStepId: null
        })
      };
    }),
  setPageUrl: (url) =>
    set((state) => {
      const pageIndex = state.session.currentPageIndex;
      const pages = state.project.pages.map((page, index) => {
        if (index !== pageIndex) return page;
        if (url) return { ...page, url };
        const { url: _removedUrl, ...pageWithoutUrl } = page;
        return pageWithoutUrl;
      });
      return { project: { ...state.project, pages }, session: withSequence(state.session, {}) };
    }),
  updateScript: (markdown) =>
    set((state) => {
      const pageIndex = state.session.currentPageIndex;
      return {
        project: {
          ...state.project,
          pages: state.project.pages.map((page, index) =>
            index === pageIndex ? { ...page, script: { ...page.script, markdown } } : page
          )
        },
        session: withSequence(state.session, {})
      };
    }),
  toggleStep: (stepId) =>
    set((state) => {
      const step = state.project.pages[state.session.currentPageIndex]?.script.steps.find((item) => item.id === stepId);
      if (step?.risk === "high" && !state.session.completedStepIds.includes(stepId)) {
        return { session: withSequence(state.session, { pendingHighRiskStepId: stepId }) };
      }
      const completed = state.session.completedStepIds.includes(stepId)
        ? state.session.completedStepIds.filter((id) => id !== stepId)
        : [...state.session.completedStepIds, stepId];
      return {
        session: withSequence(state.session, {
          completedStepIds: completed,
          forcedStepCompletions: withoutForcedCompletion(state.session, stepId),
          pendingHighRiskStepId: null
        })
      };
    }),
  completeStep: (stepId) =>
    set((state) => ({
      session: withSequence(state.session, {
        completedStepIds: state.session.completedStepIds.includes(stepId) ? state.session.completedStepIds : [...state.session.completedStepIds, stepId],
        forcedStepCompletions: withoutForcedCompletion(state.session, stepId),
        pendingHighRiskStepId: state.session.pendingHighRiskStepId === stepId ? null : state.session.pendingHighRiskStepId
      })
    })),
  forceCompleteStep: (stepId, reason) =>
    set((state) => {
      const step = state.project.pages[state.session.currentPageIndex]?.script.steps.find((item) => item.id === stepId);
      const normalizedReason = reason.trim().slice(0, 500);
      if (!step || !normalizedReason) return state;
      return {
        session: withSequence(state.session, {
          completedStepIds: state.session.completedStepIds.includes(stepId) ? state.session.completedStepIds : [...state.session.completedStepIds, stepId],
          forcedStepCompletions: [
            ...withoutForcedCompletion(state.session, stepId),
            { stepId, reason: normalizedReason, at: Date.now() }
          ],
          pendingHighRiskStepId: state.session.pendingHighRiskStepId === stepId ? null : state.session.pendingHighRiskStepId
        })
      };
    }),
  nextStep: () =>
    set((state) => {
      const page = state.project.pages[state.session.currentPageIndex];
      const next = page?.script.steps.find((step) => !state.session.completedStepIds.includes(step.id));
      if (!next) {
        if (state.session.currentPageIndex >= state.project.pages.length - 1) return state;
        const now = Date.now();
        const settled = settleAutoAdvance(settleTimer(state.session, now), now);
        const targetPage = state.project.pages[state.session.currentPageIndex + 1];
        const rehearsalPageMs = state.rehearsalStartedAt !== null && page
          ? { ...state.rehearsalPageMs, [page.id]: (state.rehearsalPageMs[page.id] ?? 0) + settled.pageElapsedMs }
          : state.rehearsalPageMs;
        return {
          rehearsalPageMs,
          session: withSequence(settled, {
            currentPageIndex: state.session.currentPageIndex + 1,
            pageElapsedMs: 0,
            sectionElapsedMs: page?.section === targetPage?.section ? settled.sectionElapsedMs : 0,
            timerStartedAt: settled.timerStatus === "running" ? now : null,
            autoAdvanceElapsedMs: 0,
            autoAdvanceStartedAt: null,
            circles: [],
            laser: null,
            annotationTool: "none",
            offlineFallbackPageId: null,
            pendingHighRiskStepId: null
          })
        };
      }
      if (next.risk === "high") return { session: withSequence(state.session, { pendingHighRiskStepId: next.id }) };
      return {
        session: withSequence(state.session, {
          completedStepIds: [...state.session.completedStepIds, next.id],
          forcedStepCompletions: withoutForcedCompletion(state.session, next.id)
        })
      };
    }),
  previousStep: () =>
    set((state) => {
      const page = state.project.pages[state.session.currentPageIndex];
      if (!page) return state;
      const pageStepIds = new Set(page.script.steps.map((step) => step.id));
      const previous = [...state.session.completedStepIds].reverse().find((id) => pageStepIds.has(id));
      if (!previous) {
        if (state.session.currentPageIndex === 0) return state;
        const targetIndex = state.session.currentPageIndex - 1;
        const targetPage = state.project.pages[targetIndex];
        if (!targetPage) return state;
        const now = Date.now();
        const settled = settleAutoAdvance(settleTimer(state.session, now), now);
        const currentPage = page;
        const rehearsalPageMs = state.rehearsalStartedAt !== null
          ? { ...state.rehearsalPageMs, [currentPage.id]: (state.rehearsalPageMs[currentPage.id] ?? 0) + settled.pageElapsedMs }
          : state.rehearsalPageMs;
        const targetStepIds = new Set(targetPage.script.steps.map((step) => step.id));
        const priorCompleted = state.session.completedStepIds.filter((id) => !targetStepIds.has(id));
        const targetCompleted = targetPage.script.steps.slice(0, -1).map((step) => step.id);
        const targetLastStepId = targetPage.script.steps.at(-1)?.id;
        return {
          rehearsalPageMs,
          session: withSequence(settled, {
            currentPageIndex: targetIndex,
            completedStepIds: [...priorCompleted, ...targetCompleted],
            forcedStepCompletions: targetLastStepId ? withoutForcedCompletion(state.session, targetLastStepId) : state.session.forcedStepCompletions,
            pageElapsedMs: 0,
            sectionElapsedMs: currentPage.section === targetPage.section ? settled.sectionElapsedMs : 0,
            timerStartedAt: settled.timerStatus === "running" ? now : null,
            autoAdvanceElapsedMs: 0,
            autoAdvanceStartedAt: null,
            circles: [],
            laser: null,
            annotationTool: "none",
            offlineFallbackPageId: null,
            pendingHighRiskStepId: null
          })
        };
      }
      return {
        session: withSequence(state.session, {
          completedStepIds: state.session.completedStepIds.filter((id) => id !== previous),
          forcedStepCompletions: withoutForcedCompletion(state.session, previous),
          pendingHighRiskStepId: null
        })
      };
    }),
  confirmHighRiskStep: () =>
    set((state) => {
      const stepId = state.session.pendingHighRiskStepId;
      const step = state.project.pages[state.session.currentPageIndex]?.script.steps.find((item) => item.id === stepId);
      if (!stepId || step?.risk !== "high") return { session: withSequence(state.session, { pendingHighRiskStepId: null }) };
      return { session: withSequence(state.session, {
        completedStepIds: state.session.completedStepIds.includes(stepId) ? state.session.completedStepIds : [...state.session.completedStepIds, stepId],
        forcedStepCompletions: withoutForcedCompletion(state.session, stepId),
        pendingHighRiskStepId: null
      }) };
    }),
  cancelHighRiskStep: () => set((state) => ({ session: withSequence(state.session, { pendingHighRiskStepId: null }) })),
  startTimer: () =>
    set((state) => {
      if (state.session.timerStatus === "running") return state;
      return {
        session: withSequence(state.session, {
          timerStatus: "running",
          timerStartedAt: Date.now()
        })
      };
    }),
  pauseTimer: () =>
    set((state) => {
      const now = Date.now();
      const settled = settleAutoAdvance(settleTimer(state.session, now), now);
      return {
        session: withSequence(settled, {
          timerStatus: "paused",
          timerStartedAt: null
        })
      };
    }),
  resetTimer: () =>
    set((state) => ({
      rehearsalStartedAt: state.rehearsalStartedAt === null ? null : Date.now(),
      rehearsalPageMs: state.rehearsalStartedAt === null ? state.rehearsalPageMs : {},
      session: withSequence(state.session, {
        timerStatus: "idle",
        totalElapsedMs: 0,
        pageElapsedMs: 0,
        sectionElapsedMs: 0,
        timerStartedAt: null,
        autoAdvanceElapsedMs: 0,
        autoAdvanceStartedAt: null
      })
    })),
  startRehearsal: () =>
    set((state) => ({
      rehearsalStartedAt: Date.now(),
      rehearsalPageMs: {},
      session: withSequence(state.session, {
        currentPageIndex: 0,
        completedStepIds: [],
        forcedStepCompletions: [],
        timerStatus: "running",
        totalElapsedMs: 0,
        pageElapsedMs: 0,
        sectionElapsedMs: 0,
        timerStartedAt: Date.now(),
        autoAdvanceElapsedMs: 0,
        autoAdvanceStartedAt: null,
        screenMode: "normal",
        annotationTool: "none",
        circles: [],
        laser: null,
        offlineFallbackPageId: null,
        offlineNetworkGrants: [],
        pendingHighRiskStepId: null
      })
    })),
  finishRehearsal: () => {
    let rehearsal: Rehearsal | null = null;
    set((state) => {
      if (state.rehearsalStartedAt === null) return state;
      const endedAt = Date.now();
      const settled = settleAutoAdvance(settleTimer(state.session, endedAt), endedAt);
      const currentPage = state.project.pages[state.session.currentPageIndex];
      const pageTimes = { ...state.rehearsalPageMs };
      if (currentPage) pageTimes[currentPage.id] = (pageTimes[currentPage.id] ?? 0) + settled.pageElapsedMs;
      rehearsal = {
        id: `rehearsal-${endedAt.toString(36)}`,
        projectId: state.project.id,
        startedAt: state.rehearsalStartedAt,
        endedAt,
        totalElapsedMs: settled.totalElapsedMs,
        note: "",
        pages: state.project.pages.map((page) => ({
          pageId: page.id,
          plannedMs: page.estimatedSeconds * 1_000,
          actualMs: Math.round(pageTimes[page.id] ?? 0)
        }))
      };
      return {
        rehearsalStartedAt: null,
        rehearsalPageMs: {},
        session: withSequence(settled, { timerStatus: "paused", timerStartedAt: null })
      };
    });
    return rehearsal;
  },
  setAutoAdvance: (enabled) =>
    set((state) => ({
      project: { ...state.project, autoAdvanceEnabled: enabled }
    })),
  setAutoAdvanceSeconds: (seconds) =>
    set((state) => ({
      project: { ...state.project, autoAdvanceSeconds: Math.round(Math.min(14_400, Math.max(1, seconds))) }
    })),
  setCurrentPageAutoAdvanceSeconds: (seconds) =>
    set((state) => ({
      project: {
        ...state.project,
        pages: state.project.pages.map((page, index) =>
          index === state.session.currentPageIndex
            ? { ...page, autoAdvanceSeconds: seconds === undefined ? undefined : Math.round(Math.min(14_400, Math.max(1, seconds))) }
            : page
        )
      }
    })),
  setAutoAdvanceRunning: (running) =>
    set((state) => {
      if (!running) {
        if (state.session.autoAdvanceStartedAt === null) return state;
        return { session: withSequence(settleAutoAdvance(state.session), {}) };
      }
      if (state.session.timerStatus !== "running" || state.session.autoAdvanceStartedAt !== null) return state;
      return { session: withSequence(state.session, { autoAdvanceStartedAt: Date.now() }) };
    }),
  setBrowserSessionMode: (browserSessionMode) =>
    set((state) => ({ session: withSequence(state.session, { browserSessionMode }) })),
  setScreenMode: (screenMode) =>
    set((state) => ({
      session: withSequence(state.session, {
        screenMode,
        annotationTool: screenMode === "normal" ? state.session.annotationTool : "none"
      })
    })),
  setOfflineFallbackActive: (active) =>
    set((state) => {
      const page = state.project.pages[state.session.currentPageIndex];
      if (!page) return state;
      return { session: withSequence(state.session, { offlineFallbackPageId: active ? page.id : null }) };
    }),
  grantOfflineNetworkOrigin: (origin) =>
    set((state) => {
      const page = state.project.pages[state.session.currentPageIndex];
      if (!page || page.offline?.kind !== "html") return state;
      const exists = state.session.offlineNetworkGrants.some((grant) => grant.pageId === page.id && grant.origin === origin);
      return {
        session: withSequence(state.session, {
          offlineNetworkGrants: exists
            ? state.session.offlineNetworkGrants
            : [...state.session.offlineNetworkGrants, { pageId: page.id, origin }]
        })
      };
    }),
  setAnnotationTool: (annotationTool) =>
    set((state) => ({
      session: withSequence(state.session, { annotationTool })
    })),
  setLaser: (laser) =>
    set((state) => ({
      session: withSequence(state.session, { laser })
    })),
  addCircle: (circle) =>
    set((state) => ({
      session: withSequence(state.session, {
        circles: [...state.session.circles, circle]
      })
    })),
  addPrivacyMask: (mask) =>
    set((state) => ({
      project: {
        ...state.project,
        pages: state.project.pages.map((page, index) => index === state.session.currentPageIndex ? { ...page, privacyMasks: [...page.privacyMasks, mask] } : page)
      },
      session: withSequence(state.session, { annotationTool: "none" })
    })),
  clearPrivacyMasks: () =>
    set((state) => ({
      project: {
        ...state.project,
        pages: state.project.pages.map((page, index) => index === state.session.currentPageIndex ? { ...page, privacyMasks: [] } : page)
      },
      session: withSequence(state.session, { annotationTool: "none" })
    })),
  clearAnnotations: () =>
    set((state) => ({
      session: withSequence(state.session, { circles: [], laser: null, annotationTool: "none" })
    })),
  audienceReady: () =>
    set((state) => ({
      session: withSequence(state.session, {
        audienceStatus: "synced",
        audienceCount: Math.max(1, state.session.audienceCount)
      })
    })),
  setAudienceCount: (count) =>
    set((state) => {
      const audienceCount = Math.max(0, Math.min(20, Math.floor(count)));
      const audienceStatus = audienceCount > 0 ? "synced" as const : "connecting" as const;
      if (state.session.audienceCount === audienceCount && state.session.audienceStatus === audienceStatus) return state;
      return { session: withSequence(state.session, { audienceStatus, audienceCount }) };
    }),
  updatePrivacyMask: (maskId, bounds) =>
    set((state) => {
      const pageIndex = state.session.currentPageIndex;
      const page = state.project.pages[pageIndex];
      const existing = page?.privacyMasks.find((mask) => mask.id === maskId);
      if (!page || !existing) return state;
      if (["x1", "y1", "x2", "y2"].every((key) => Math.abs(existing[key as keyof typeof bounds] - bounds[key as keyof typeof bounds]) < 0.0005)) return state;
      return {
        project: { ...state.project, pages: state.project.pages.map((item, index) => index === pageIndex ? { ...item, privacyMasks: item.privacyMasks.map((mask) => mask.id === maskId ? { ...mask, ...bounds } : mask) } : item) },
        session: withSequence(state.session, {})
      };
    }),
  audienceDisconnected: () =>
    set((state) => ({
      session: withSequence(state.session, { audienceStatus: "disconnected", audienceCount: 0 })
    })),
  endPresentation: () =>
    set((state) => ({
      session: withSequence(settleAutoAdvance(settleTimer(state.session)), {
        timerStatus: "paused",
        timerStartedAt: null,
        autoAdvanceStartedAt: null,
        screenMode: "ended",
        annotationTool: "none",
        laser: null,
        // Offline network grants are per-run consent — do not leave origins
        // pre-authorized for the next presentation or rehearsal.
        offlineNetworkGrants: [],
        pendingHighRiskStepId: null
      })
    }))
}));
