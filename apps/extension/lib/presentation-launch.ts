import { PresentationSessionSchema, ProjectSchema, type PresentationSession, type Project } from "@showit/contracts";
import { createSession } from "./project-workspace";
import type { Workspace } from "./persistence";

function parseWorkspace(value: unknown): Workspace | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { project?: unknown; session?: unknown };
  const project = ProjectSchema.safeParse(candidate.project);
  const session = PresentationSessionSchema.safeParse(candidate.session);
  if (!project.success || !session.success || project.data.id !== session.data.projectId) return null;
  return { project: project.data, session: session.data };
}

function runnableProject(value: Project): Project {
  const project = ProjectSchema.parse(value);
  const pages = project.pages.filter((page) => page.enabled).map((page, order) => ({ ...page, order }));
  if (pages.length === 0) throw new Error("项目没有启用的演示页面。");
  return { ...project, pages, totalPlannedSeconds: Math.max(1, pages.reduce((total, page) => total + page.estimatedSeconds, 0)) };
}

function runtimeSession(sourceProject: Project, project: Project, sourceSession: PresentationSession): PresentationSession {
  const sourcePageIndex = Math.max(0, Math.min(sourceProject.pages.length - 1, sourceSession.currentPageIndex));
  const currentPageId = sourceProject.pages[sourcePageIndex]?.id;
  let currentPageIndex = currentPageId ? project.pages.findIndex((page) => page.id === currentPageId) : -1;
  if (currentPageIndex < 0) {
    const nextEnabledPage = sourceProject.pages.slice(sourcePageIndex + 1).find((page) => page.enabled);
    currentPageIndex = nextEnabledPage ? project.pages.findIndex((page) => page.id === nextEnabledPage.id) : 0;
  }
  const activePageId = project.pages[currentPageIndex]?.id;
  const stayedOnPage = activePageId === currentPageId;
  const stayedInSection = sourceProject.pages[sourcePageIndex]?.section === project.pages[currentPageIndex]?.section;
  const validPageIds = new Set(project.pages.map((page) => page.id));
  const validStepIds = new Set(project.pages.flatMap((page) => page.script.steps.map((step) => step.id)));
  const activeStepIds = new Set(project.pages[currentPageIndex]?.script.steps.map((step) => step.id) ?? []);

  return {
    ...sourceSession,
    // A run always opens on a live picture. Ending a presentation persists
    // screenMode "ended" into the stored session, so it must be reset here —
    // otherwise the next run starts on the 演示结束 cover.
    screenMode: "normal",
    audienceStatus: "disconnected",
    audienceCount: 0,
    currentPageIndex,
    pageElapsedMs: stayedOnPage ? sourceSession.pageElapsedMs : 0,
    sectionElapsedMs: stayedInSection ? sourceSession.sectionElapsedMs : 0,
    timerStartedAt: !stayedOnPage && sourceSession.timerStatus === "running" ? Date.now() : sourceSession.timerStartedAt,
    autoAdvanceElapsedMs: stayedOnPage ? sourceSession.autoAdvanceElapsedMs : 0,
    autoAdvanceStartedAt: null,
    completedStepIds: sourceSession.completedStepIds.filter((stepId) => validStepIds.has(stepId)),
    forcedStepCompletions: sourceSession.forcedStepCompletions.filter((completion) => validStepIds.has(completion.stepId)),
    pendingHighRiskStepId: sourceSession.pendingHighRiskStepId && activeStepIds.has(sourceSession.pendingHighRiskStepId)
      ? sourceSession.pendingHighRiskStepId
      : null,
    offlineFallbackPageId: sourceSession.offlineFallbackPageId === activePageId
      ? sourceSession.offlineFallbackPageId
      : null,
    offlineNetworkGrants: sourceSession.offlineNetworkGrants.filter((grant) => validPageIds.has(grant.pageId)),
    annotationTool: stayedOnPage ? sourceSession.annotationTool : "none",
    circles: stayedOnPage ? sourceSession.circles : [],
    laser: stayedOnPage ? sourceSession.laser : null
  };
}

/** Build the isolated runtime workspace for a presentation run: disabled
 *  pages are stripped and the session migrates onto the filtered page list. */
export function beginPresentationLaunch(project: Project, session: PresentationSession = createSession(project)): Workspace {
  const runtimeProject = runnableProject(project);
  const sessionSnapshot = session.projectId === runtimeProject.id
    ? runtimeSession(project, runtimeProject, session)
    : createSession(runtimeProject);
  const workspace = parseWorkspace({ project: runtimeProject, session: sessionSnapshot });
  if (!workspace) throw new Error("无法创建演示启动快照。");
  return workspace;
}

export function applyProjectToPresentation(workspace: Workspace, latestProject: Project): Workspace {
  const project = runnableProject(latestProject);
  if (project.id !== workspace.project.id) throw new Error("项目与当前演示会话不匹配。");
  const currentPageId = workspace.project.pages[workspace.session.currentPageIndex]?.id;
  // When the current page disappeared, advance to the next enabled page
  // instead of throwing the presenter back to the cover page mid-talk —
  // mirroring the recovery path in runtimeSession().
  const directIndex = currentPageId ? project.pages.findIndex((page) => page.id === currentPageId) : -1;
  const successor = workspace.project.pages
    .slice(workspace.session.currentPageIndex + 1)
    .find((page) => page.enabled);
  const successorIndex = successor ? project.pages.findIndex((page) => page.id === successor.id) : -1;
  const currentPageIndex = directIndex >= 0 ? directIndex : successorIndex >= 0 ? successorIndex : 0;
  const activePageId = project.pages[currentPageIndex]?.id;
  const stayedOnPage = activePageId === currentPageId;
  const stayedInSection = workspace.project.pages[workspace.session.currentPageIndex]?.section === project.pages[currentPageIndex]?.section;
  const validPageIds = new Set(project.pages.map((page) => page.id));
  const validStepIds = new Set(project.pages.flatMap((page) => page.script.steps.map((step) => step.id)));
  const activePage = project.pages[currentPageIndex];
  const activeStepIds = new Set(activePage?.script.steps.map((step) => step.id) ?? []);
  const session: PresentationSession = {
    ...workspace.session,
    currentPageIndex,
    pageElapsedMs: stayedOnPage ? workspace.session.pageElapsedMs : 0,
    sectionElapsedMs: stayedInSection ? workspace.session.sectionElapsedMs : 0,
    timerStartedAt: !stayedOnPage && workspace.session.timerStatus === "running" ? Date.now() : workspace.session.timerStartedAt,
    autoAdvanceElapsedMs: stayedOnPage ? workspace.session.autoAdvanceElapsedMs : 0,
    autoAdvanceStartedAt: null,
    completedStepIds: workspace.session.completedStepIds.filter((id) => validStepIds.has(id)),
    forcedStepCompletions: workspace.session.forcedStepCompletions.filter((item) => validStepIds.has(item.stepId)),
    pendingHighRiskStepId: workspace.session.pendingHighRiskStepId && activeStepIds.has(workspace.session.pendingHighRiskStepId)
      ? workspace.session.pendingHighRiskStepId
      : null,
    offlineFallbackPageId: workspace.session.offlineFallbackPageId === activePageId
      ? workspace.session.offlineFallbackPageId
      : null,
    offlineNetworkGrants: workspace.session.offlineNetworkGrants.filter((grant) => validPageIds.has(grant.pageId)),
    annotationTool: stayedOnPage ? workspace.session.annotationTool : "none",
    circles: stayedOnPage ? workspace.session.circles : [],
    laser: stayedOnPage ? workspace.session.laser : null,
    sequence: workspace.session.sequence + 1
  };
  const next = { project, session };
  const parsed = parseWorkspace(next);
  if (!parsed) throw new Error("应用项目变更后的演示快照无效。");
  return parsed;
}
