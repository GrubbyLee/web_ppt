import type { Circle, PresentationSession, PrivacyMask, Project, ProjectLayout, Rehearsal, ScreenMode } from "@showit/contracts";
import { createProject, createSession } from "../lib/project-workspace";
import { emptyPresenterEditScope, type PresenterEditScope, type PresenterPageEditKind, type PresenterProjectEditKind } from "../lib/presenter-edits";

export type MachineState = {
  project: Project;
  session: PresentationSession;
  rehearsalStartedAt: number | null;
  rehearsalPageMs: Record<string, number>;
  /** Runtime-only tracker of live presenter edits, merged into the project
   *  library on exit (see lib/presenter-edits.ts). Never part of the schema. */
  presenterEdits: PresenterEditScope;
  /** True while the presenter's own local audience window is open. */
  localAudience: boolean;
};

export type SessionAction =
  | { type: "set-workspace"; project: Project; session: PresentationSession }
  | { type: "set-stage-percent"; stagePercent: number }
  | { type: "set-layout-preset"; preset: ProjectLayout["preset"] }
  | { type: "set-note-font-scale"; fontScale: number }
  | { type: "set-active-page"; index: number }
  | { type: "set-page-url"; url: string | undefined }
  | { type: "update-script"; markdown: string }
  | { type: "toggle-step"; stepId: string }
  | { type: "complete-step"; stepId: string }
  | { type: "force-complete-step"; stepId: string; reason: string }
  | { type: "next-step" }
  | { type: "previous-step" }
  | { type: "confirm-high-risk-step" }
  | { type: "cancel-high-risk-step" }
  | { type: "start-timer" }
  | { type: "pause-timer" }
  | { type: "reset-timer" }
  | { type: "start-rehearsal" }
  | { type: "finish-rehearsal"; note?: string }
  | { type: "set-auto-advance"; enabled: boolean }
  | { type: "set-auto-advance-seconds"; seconds: number }
  | { type: "set-current-page-auto-advance-seconds"; seconds: number | undefined }
  | { type: "set-auto-advance-running"; running: boolean }
  | { type: "set-browser-session-mode"; mode: PresentationSession["browserSessionMode"] }
  | { type: "set-screen-mode"; screenMode: ScreenMode }
  | { type: "set-offline-fallback-active"; active: boolean }
  | { type: "grant-offline-network-origin"; origin: string }
  | { type: "set-annotation-tool"; tool: PresentationSession["annotationTool"] }
  | { type: "set-laser"; laser: PresentationSession["laser"] }
  | { type: "add-circle"; circle: Circle }
  | { type: "add-privacy-mask"; mask: PrivacyMask }
  | { type: "update-privacy-mask"; maskId: string; bounds: Pick<PrivacyMask, "x1" | "y1" | "x2" | "y2"> }
  | { type: "clear-privacy-masks" }
  | { type: "clear-annotations" }
  | { type: "audience-ready" }
  | { type: "set-audience-count"; count: number }
  | { type: "audience-disconnected" }
  | { type: "local-audience-closed" }
  | { type: "end-presentation" };

export type ApplyResult = { state: MachineState; rehearsal?: Rehearsal };

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

type EditTrackingState = {
  project: Project;
  session: PresentationSession;
  presenterEdits: PresenterEditScope;
};

function markPageEdit(state: EditTrackingState, kind: PresenterPageEditKind): PresenterEditScope {
  const pageId = state.project.pages[state.session.currentPageIndex]?.id;
  if (!pageId) return state.presenterEdits;
  const current = state.presenterEdits.pageEdits[pageId] ?? [];
  if (current.includes(kind)) return state.presenterEdits;
  return { ...state.presenterEdits, pageEdits: { ...state.presenterEdits.pageEdits, [pageId]: [...current, kind] } };
}

function markProjectEdit(state: EditTrackingState, kind: PresenterProjectEditKind): PresenterEditScope {
  if (state.presenterEdits.projectEdits.includes(kind)) return state.presenterEdits;
  return { ...state.presenterEdits, projectEdits: [...state.presenterEdits.projectEdits, kind] };
}

const presetStagePercent: Record<ProjectLayout["preset"], number> = {
  stage: 66,
  balanced: 56,
  notes: 50
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

export function initialMachineState(): MachineState {
  const project = createProject("未命名演示");
  return {
    project,
    session: createSession(project),
    rehearsalStartedAt: null,
    rehearsalPageMs: {},
    presenterEdits: emptyPresenterEditScope,
    localAudience: false
  };
}

function moveResult(state: MachineState, settled: PresentationSession, targetIndex: number, extra: Partial<PresentationSession> = {}): ApplyResult {
  const currentPage = state.project.pages[state.session.currentPageIndex];
  const targetPage = state.project.pages[targetIndex];
  const rehearsalPageMs = state.rehearsalStartedAt !== null && currentPage
    ? { ...state.rehearsalPageMs, [currentPage.id]: (state.rehearsalPageMs[currentPage.id] ?? 0) + settled.pageElapsedMs }
    : state.rehearsalPageMs;
  return {
    state: {
      ...state,
      rehearsalPageMs,
      session: withSequence(settled, {
        currentPageIndex: targetIndex,
        pageElapsedMs: 0,
        sectionElapsedMs: currentPage?.section === targetPage?.section ? settled.sectionElapsedMs : 0,
        timerStartedAt: settled.timerStatus === "running" ? Date.now() : null,
        autoAdvanceElapsedMs: 0,
        autoAdvanceStartedAt: null,
        circles: [],
        laser: null,
        annotationTool: "none",
        offlineFallbackPageId: null,
        pendingHighRiskStepId: null,
        ...extra
      })
    }
  };
}

export function applyAction(input: MachineState, action: SessionAction, now = Date.now()): ApplyResult {
  switch (action.type) {
    case "set-workspace":
      return {
        state: {
          ...input,
          project: action.project,
          session: action.session,
          rehearsalStartedAt: null,
          rehearsalPageMs: {},
          presenterEdits: emptyPresenterEditScope,
          localAudience: false
        }
      };
    case "set-stage-percent": {
      const clamped = Math.round(Math.min(66, Math.max(50, action.stagePercent)));
      // Dragging the divider leaves the preset chip stale unless it tracks
      // the closest named layout.
      const preset = (Object.keys(presetStagePercent) as Array<ProjectLayout["preset"]>).reduce((best, candidate) =>
        Math.abs(presetStagePercent[candidate] - clamped) < Math.abs(presetStagePercent[best] - clamped) ? candidate : best);
      return {
        state: {
          ...input,
          project: { ...input.project, layout: { ...input.project.layout, stagePercent: clamped, preset } },
          presenterEdits: markProjectEdit(input, "layout")
        }
      };
    }
    case "set-layout-preset":
      return {
        state: {
          ...input,
          project: { ...input.project, layout: { ...input.project.layout, preset: action.preset, stagePercent: presetStagePercent[action.preset] } },
          presenterEdits: markProjectEdit(input, "layout")
        }
      };
    case "set-note-font-scale":
      return {
        state: {
          ...input,
          project: { ...input.project, layout: { ...input.project.layout, noteFontScale: Math.min(1.35, Math.max(0.85, Number(action.fontScale.toFixed(2)))) } },
          presenterEdits: markProjectEdit(input, "layout")
        }
      };
    case "set-active-page": {
      const targetIndex = Math.max(0, Math.min(input.project.pages.length - 1, action.index));
      if (targetIndex === input.session.currentPageIndex) return { state: input };
      return moveResult(input, settleAutoAdvance(settleTimer(input.session, now), now), targetIndex);
    }
    case "set-page-url": {
      const pageIndex = input.session.currentPageIndex;
      const pages = input.project.pages.map((page, index) => {
        if (index !== pageIndex) return page;
        if (action.url) return { ...page, url: action.url };
        const { url: _removedUrl, ...pageWithoutUrl } = page;
        return pageWithoutUrl;
      });
      return { state: { ...input, project: { ...input.project, pages }, session: withSequence(input.session, {}), presenterEdits: markPageEdit(input, "url") } };
    }
    case "update-script": {
      const pageIndex = input.session.currentPageIndex;
      return {
        state: {
          ...input,
          project: {
            ...input.project,
            pages: input.project.pages.map((page, index) => index === pageIndex ? { ...page, script: { ...page.script, markdown: action.markdown } } : page)
          },
          session: withSequence(input.session, {}),
          presenterEdits: markPageEdit(input, "script")
        }
      };
    }
    case "toggle-step": {
      const step = input.project.pages[input.session.currentPageIndex]?.script.steps.find((item) => item.id === action.stepId);
      if (step?.risk === "high" && !input.session.completedStepIds.includes(action.stepId)) {
        return { state: { ...input, session: withSequence(input.session, { pendingHighRiskStepId: action.stepId }) } };
      }
      const completed = input.session.completedStepIds.includes(action.stepId)
        ? input.session.completedStepIds.filter((id) => id !== action.stepId)
        : [...input.session.completedStepIds, action.stepId];
      return {
        state: {
          ...input,
          session: withSequence(input.session, {
            completedStepIds: completed,
            forcedStepCompletions: withoutForcedCompletion(input.session, action.stepId),
            pendingHighRiskStepId: null
          })
        }
      };
    }
    case "complete-step":
      return {
        state: {
          ...input,
          session: withSequence(input.session, {
            completedStepIds: input.session.completedStepIds.includes(action.stepId) ? input.session.completedStepIds : [...input.session.completedStepIds, action.stepId],
            forcedStepCompletions: withoutForcedCompletion(input.session, action.stepId),
            pendingHighRiskStepId: input.session.pendingHighRiskStepId === action.stepId ? null : input.session.pendingHighRiskStepId
          })
        }
      };
    case "force-complete-step": {
      const step = input.project.pages[input.session.currentPageIndex]?.script.steps.find((item) => item.id === action.stepId);
      const normalizedReason = action.reason.trim().slice(0, 500);
      if (!step || !normalizedReason) return { state: input };
      return {
        state: {
          ...input,
          session: withSequence(input.session, {
            completedStepIds: input.session.completedStepIds.includes(action.stepId) ? input.session.completedStepIds : [...input.session.completedStepIds, action.stepId],
            forcedStepCompletions: [...withoutForcedCompletion(input.session, action.stepId), { stepId: action.stepId, reason: normalizedReason, at: Date.now() }],
            pendingHighRiskStepId: input.session.pendingHighRiskStepId === action.stepId ? null : input.session.pendingHighRiskStepId
          })
        }
      };
    }
    case "next-step": {
      const page = input.project.pages[input.session.currentPageIndex];
      const next = page?.script.steps.find((step) => !input.session.completedStepIds.includes(step.id));
      if (!next) {
        if (input.session.currentPageIndex >= input.project.pages.length - 1) return { state: input };
        return moveResult(input, settleAutoAdvance(settleTimer(input.session, now), now), input.session.currentPageIndex + 1);
      }
      if (next.risk === "high") return { state: { ...input, session: withSequence(input.session, { pendingHighRiskStepId: next.id }) } };
      return {
        state: {
          ...input,
          session: withSequence(input.session, {
            completedStepIds: [...input.session.completedStepIds, next.id],
            forcedStepCompletions: withoutForcedCompletion(input.session, next.id)
          })
        }
      };
    }
    case "previous-step": {
      const page = input.project.pages[input.session.currentPageIndex];
      if (!page) return { state: input };
      const pageStepIds = new Set(page.script.steps.map((step) => step.id));
      const previous = [...input.session.completedStepIds].reverse().find((id) => pageStepIds.has(id));
      if (!previous) {
        if (input.session.currentPageIndex === 0) return { state: input };
        const targetIndex = input.session.currentPageIndex - 1;
        const targetPage = input.project.pages[targetIndex];
        if (!targetPage) return { state: input };
        const settled = settleAutoAdvance(settleTimer(input.session, now), now);
        const targetStepIds = new Set(targetPage.script.steps.map((step) => step.id));
        const priorCompleted = input.session.completedStepIds.filter((id) => !targetStepIds.has(id));
        const targetCompleted = targetPage.script.steps.slice(0, -1).map((step) => step.id);
        const targetLastStepId = targetPage.script.steps.at(-1)?.id;
        return {
          state: {
            ...input,
            rehearsalPageMs: input.rehearsalStartedAt !== null
              ? { ...input.rehearsalPageMs, [page.id]: (input.rehearsalPageMs[page.id] ?? 0) + settled.pageElapsedMs }
              : input.rehearsalPageMs,
            session: withSequence(settled, {
              currentPageIndex: targetIndex,
              completedStepIds: [...priorCompleted, ...targetCompleted],
              forcedStepCompletions: targetLastStepId ? withoutForcedCompletion(input.session, targetLastStepId) : input.session.forcedStepCompletions,
              pageElapsedMs: 0,
              sectionElapsedMs: page.section === targetPage.section ? settled.sectionElapsedMs : 0,
              timerStartedAt: settled.timerStatus === "running" ? now : null,
              autoAdvanceElapsedMs: 0,
              autoAdvanceStartedAt: null,
              circles: [],
              laser: null,
              annotationTool: "none",
              offlineFallbackPageId: null,
              pendingHighRiskStepId: null
            })
          }
        };
      }
      return {
        state: {
          ...input,
          session: withSequence(input.session, {
            completedStepIds: input.session.completedStepIds.filter((id) => id !== previous),
            forcedStepCompletions: withoutForcedCompletion(input.session, previous),
            pendingHighRiskStepId: null
          })
        }
      };
    }
    case "confirm-high-risk-step": {
      const stepId = input.session.pendingHighRiskStepId;
      const step = input.project.pages[input.session.currentPageIndex]?.script.steps.find((item) => item.id === stepId);
      if (!stepId || step?.risk !== "high") return { state: { ...input, session: withSequence(input.session, { pendingHighRiskStepId: null }) } };
      return {
        state: {
          ...input,
          session: withSequence(input.session, {
            completedStepIds: input.session.completedStepIds.includes(stepId) ? input.session.completedStepIds : [...input.session.completedStepIds, stepId],
            forcedStepCompletions: withoutForcedCompletion(input.session, stepId),
            pendingHighRiskStepId: null
          })
        }
      };
    }
    case "cancel-high-risk-step":
      return { state: { ...input, session: withSequence(input.session, { pendingHighRiskStepId: null }) } };
    case "start-timer":
      if (input.session.timerStatus === "running") return { state: input };
      return { state: { ...input, session: withSequence(input.session, { timerStatus: "running", timerStartedAt: Date.now() }) } };
    case "pause-timer": {
      const settled = settleAutoAdvance(settleTimer(input.session, now), now);
      return { state: { ...input, session: withSequence(settled, { timerStatus: "paused", timerStartedAt: null }) } };
    }
    case "reset-timer":
      return {
        state: {
          ...input,
          rehearsalStartedAt: input.rehearsalStartedAt === null ? null : Date.now(),
          rehearsalPageMs: input.rehearsalStartedAt === null ? input.rehearsalPageMs : {},
          session: withSequence(input.session, {
            timerStatus: "idle",
            totalElapsedMs: 0,
            pageElapsedMs: 0,
            sectionElapsedMs: 0,
            timerStartedAt: null,
            autoAdvanceElapsedMs: 0,
            autoAdvanceStartedAt: null
          })
        }
      };
    case "start-rehearsal":
      return {
        state: {
          ...input,
          rehearsalStartedAt: Date.now(),
          rehearsalPageMs: {},
          session: withSequence(input.session, {
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
        }
      };
    case "finish-rehearsal": {
      if (input.rehearsalStartedAt === null) return { state: input };
      const endedAt = Date.now();
      const settled = settleAutoAdvance(settleTimer(input.session, endedAt), endedAt);
      const currentPage = input.project.pages[input.session.currentPageIndex];
      const pageTimes = { ...input.rehearsalPageMs };
      if (currentPage) pageTimes[currentPage.id] = (pageTimes[currentPage.id] ?? 0) + settled.pageElapsedMs;
      const rehearsal: Rehearsal = {
        id: `rehearsal-${endedAt.toString(36)}`,
        projectId: input.project.id,
        startedAt: input.rehearsalStartedAt,
        endedAt,
        totalElapsedMs: settled.totalElapsedMs,
        note: (action.note ?? "").trim().slice(0, 2_000),
        pages: input.project.pages.map((page) => ({
          pageId: page.id,
          plannedMs: page.estimatedSeconds * 1_000,
          actualMs: Math.round(pageTimes[page.id] ?? 0)
        }))
      };
      return {
        state: {
          ...input,
          rehearsalStartedAt: null,
          rehearsalPageMs: {},
          session: withSequence(settled, { timerStatus: "paused", timerStartedAt: null })
        },
        rehearsal
      };
    }
    case "set-auto-advance":
      return {
        state: {
          ...input,
          project: { ...input.project, autoAdvanceEnabled: action.enabled },
          presenterEdits: markProjectEdit(input, "autoAdvance")
        }
      };
    case "set-auto-advance-seconds":
      return {
        state: {
          ...input,
          project: { ...input.project, autoAdvanceSeconds: Math.round(Math.min(14_400, Math.max(1, action.seconds))) },
          presenterEdits: markProjectEdit(input, "autoAdvance")
        }
      };
    case "set-current-page-auto-advance-seconds":
      return {
        state: {
          ...input,
          project: {
            ...input.project,
            pages: input.project.pages.map((page, index) =>
              index === input.session.currentPageIndex
                ? { ...page, autoAdvanceSeconds: action.seconds === undefined ? undefined : Math.round(Math.min(14_400, Math.max(1, action.seconds))) }
                : page
            )
          },
          presenterEdits: markPageEdit(input, "autoAdvance")
        }
      };
    case "set-auto-advance-running": {
      if (!action.running) {
        if (input.session.autoAdvanceStartedAt === null) return { state: input };
        return { state: { ...input, session: withSequence(settleAutoAdvance(input.session), {}) } };
      }
      if (input.session.timerStatus !== "running" || input.session.autoAdvanceStartedAt !== null) return { state: input };
      return { state: { ...input, session: withSequence(input.session, { autoAdvanceStartedAt: Date.now() }) } };
    }
    case "set-browser-session-mode":
      return { state: { ...input, session: withSequence(input.session, { browserSessionMode: action.mode }) } };
    case "set-screen-mode":
      return {
        state: {
          ...input,
          session: withSequence(input.session, {
            screenMode: action.screenMode,
            annotationTool: action.screenMode === "normal" ? input.session.annotationTool : "none"
          })
        }
      };
    case "set-offline-fallback-active": {
      const page = input.project.pages[input.session.currentPageIndex];
      if (!page) return { state: input };
      return { state: { ...input, session: withSequence(input.session, { offlineFallbackPageId: action.active ? page.id : null }) } };
    }
    case "grant-offline-network-origin": {
      const page = input.project.pages[input.session.currentPageIndex];
      if (!page || page.offline?.kind !== "html") return { state: input };
      const exists = input.session.offlineNetworkGrants.some((grant) => grant.pageId === page.id && grant.origin === action.origin);
      return {
        state: {
          ...input,
          session: withSequence(input.session, {
            offlineNetworkGrants: exists
              ? input.session.offlineNetworkGrants
              : [...input.session.offlineNetworkGrants, { pageId: page.id, origin: action.origin }]
          })
        }
      };
    }
    case "set-annotation-tool":
      return { state: { ...input, session: withSequence(input.session, { annotationTool: action.tool }) } };
    case "set-laser":
      return { state: { ...input, session: withSequence(input.session, { laser: action.laser }) } };
    case "add-circle":
      return { state: { ...input, session: withSequence(input.session, { circles: [...input.session.circles, action.circle] }) } };
    case "add-privacy-mask":
      return {
        state: {
          ...input,
          project: {
            ...input.project,
            pages: input.project.pages.map((page, index) => index === input.session.currentPageIndex ? { ...page, privacyMasks: [...page.privacyMasks, action.mask] } : page)
          },
          session: withSequence(input.session, { annotationTool: "none" }),
          presenterEdits: markPageEdit(input, "masks")
        }
      };
    case "update-privacy-mask": {
      const pageIndex = input.session.currentPageIndex;
      const page = input.project.pages[pageIndex];
      const existing = page?.privacyMasks.find((mask) => mask.id === action.maskId);
      if (!page || !existing) return { state: input };
      if (["x1", "y1", "x2", "y2"].every((key) => Math.abs(existing[key as keyof typeof action.bounds] - action.bounds[key as keyof typeof action.bounds]) < 0.0005)) return { state: input };
      return {
        state: {
          ...input,
          project: { ...input.project, pages: input.project.pages.map((item, index) => index === pageIndex ? { ...item, privacyMasks: item.privacyMasks.map((mask) => mask.id === action.maskId ? { ...mask, ...action.bounds } : mask) } : item) },
          session: withSequence(input.session, {}),
          presenterEdits: markPageEdit(input, "masks")
        }
      };
    }
    case "clear-privacy-masks":
      return {
        state: {
          ...input,
          project: {
            ...input.project,
            pages: input.project.pages.map((page, index) => index === input.session.currentPageIndex ? { ...page, privacyMasks: [] } : page)
          },
          session: withSequence(input.session, { annotationTool: "none" }),
          presenterEdits: markPageEdit(input, "masks")
        }
      };
    case "clear-annotations":
      return { state: { ...input, session: withSequence(input.session, { circles: [], laser: null, annotationTool: "none" }) } };
    case "audience-ready":
      return {
        state: {
          ...input,
          localAudience: true,
          session: withSequence(input.session, { audienceStatus: "synced" })
        }
      };
    case "set-audience-count": {
      const audienceCount = Math.max(0, Math.min(20, Math.floor(action.count)));
      const audienceStatus = audienceCount > 0 || input.localAudience ? "synced" as const : "connecting" as const;
      if (input.session.audienceCount === audienceCount && input.session.audienceStatus === audienceStatus) return { state: input };
      return { state: { ...input, session: withSequence(input.session, { audienceStatus, audienceCount }) } };
    }
    case "audience-disconnected":
      return {
        state: {
          ...input,
          // The audience share dropped, but the presenter's own local audience
          // window (if open) keeps its direct video feed.
          session: withSequence(input.session, {
            audienceStatus: input.localAudience ? "synced" : "disconnected",
            audienceCount: 0
          })
        }
      };
    case "local-audience-closed":
      return {
        state: {
          ...input,
          localAudience: false,
          session: withSequence(input.session, {
            audienceStatus: input.session.audienceCount > 0 ? input.session.audienceStatus : "disconnected",
            audienceCount: input.session.audienceCount
          })
        }
      };
    case "end-presentation":
      return {
        state: {
          ...input,
          session: withSequence(settleAutoAdvance(settleTimer(input.session)), {
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
          }),
          presenterEdits: emptyPresenterEditScope,
          localAudience: false
        }
      };
  }
}
