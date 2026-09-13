import { afterEach, describe, expect, it } from "vitest";
import { sampleProject } from "./sample-project";
import { createSession } from "./project-workspace";
import { applyProjectToPresentation, beginPresentationLaunch, clearPresentationLaunch, loadPresentationLaunch } from "./presentation-launch";

describe("presentation launch snapshot", () => {
  afterEach(() => clearPresentationLaunch(sampleProject.id));

  it("keeps an isolated startup project", () => {
    beginPresentationLaunch(sampleProject);
    const loaded = loadPresentationLaunch(sampleProject.id)!;
    const originalName = loaded.project.name;
    loaded.project.name = "运行时副本";
    expect(loadPresentationLaunch(sampleProject.id)?.project.name).toBe(originalName);
  });

  it("applies editor changes only through an explicit merge", () => {
    const session = createSession(sampleProject);
    session.currentPageIndex = 1;
    session.completedStepIds = [sampleProject.pages[0]!.script.steps[0]!.id, "removed-step"];
    const running = beginPresentationLaunch(sampleProject, session);
    const latest = { ...sampleProject, name: "编辑后的项目", pages: sampleProject.pages.map((page) => ({ ...page })) };
    expect(loadPresentationLaunch(sampleProject.id)?.project.name).toBe(sampleProject.name);
    const applied = applyProjectToPresentation(running, latest);
    expect(applied.project.name).toBe("编辑后的项目");
    expect(applied.session.currentPageIndex).toBe(1);
    expect(applied.session.completedStepIds).not.toContain("removed-step");
  });

  it("excludes disabled pages from a running snapshot", () => {
    const project = { ...sampleProject, pages: sampleProject.pages.map((page, index) => ({ ...page, enabled: index !== 1 })) };
    const launch = beginPresentationLaunch(project);
    expect(launch.project.pages).toHaveLength(sampleProject.pages.length - 1);
    expect(launch.project.pages.every((page) => page.enabled)).toBe(true);
    expect(launch.project.pages.map((page) => page.order)).toEqual(launch.project.pages.map((_page, index) => index));
  });

  it("moves a session on a disabled page to the next enabled page and removes disabled state", () => {
    const project = structuredClone(sampleProject);
    project.pages[1]!.enabled = false;
    const disabledStepId = project.pages[1]!.script.steps[0]!.id;
    const session = createSession(project);
    session.currentPageIndex = 1;
    session.completedStepIds = [disabledStepId];
    session.forcedStepCompletions = [{ stepId: disabledStepId, reason: "旧页面", at: Date.now() }];
    session.pendingHighRiskStepId = disabledStepId;
    session.offlineFallbackPageId = project.pages[1]!.id;
    session.offlineNetworkGrants = [{ pageId: project.pages[1]!.id, origin: "https://assets.example.com" }];
    session.annotationTool = "circle";
    session.circles = [{ id: "disabled-circle", x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.4 }];
    session.laser = { x: 0.3, y: 0.2, expiresAt: Date.now() + 1_000 };
    session.pageElapsedMs = 12_000;
    session.sectionElapsedMs = 16_000;
    session.autoAdvanceElapsedMs = 4_000;

    const launch = beginPresentationLaunch(project, session);

    expect(launch.project.pages.map((page) => page.id)).not.toContain(project.pages[1]!.id);
    expect(launch.session.currentPageIndex).toBe(1);
    expect(launch.project.pages[launch.session.currentPageIndex]?.id).toBe(project.pages[2]!.id);
    expect(launch.session.completedStepIds).toEqual([]);
    expect(launch.session.forcedStepCompletions).toEqual([]);
    expect(launch.session.pendingHighRiskStepId).toBeNull();
    expect(launch.session.offlineFallbackPageId).toBeNull();
    expect(launch.session.offlineNetworkGrants).toEqual([]);
    expect(launch.session.annotationTool).toBe("none");
    expect(launch.session.circles).toEqual([]);
    expect(launch.session.laser).toBeNull();
    expect(launch.session.pageElapsedMs).toBe(0);
    expect(launch.session.sectionElapsedMs).toBe(0);
    expect(launch.session.autoAdvanceElapsedMs).toBe(0);
  });

  it("returns to the first enabled page when a disabled page has no enabled successor", () => {
    const project = structuredClone(sampleProject);
    project.pages[project.pages.length - 1]!.enabled = false;
    const session = createSession(project);
    session.currentPageIndex = project.pages.length - 1;

    const launch = beginPresentationLaunch(project, session);

    expect(launch.session.currentPageIndex).toBe(0);
    expect(launch.project.pages[0]?.id).toBe(project.pages[0]?.id);
  });

  it("clears page-local state when applying editor changes removes the current page", () => {
    const session = createSession(sampleProject);
    session.currentPageIndex = 1;
    session.annotationTool = "circle";
    session.circles = [{ id: "removed-circle", x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.4 }];
    session.laser = { x: 0.2, y: 0.3, expiresAt: Date.now() + 1_000 };
    session.offlineFallbackPageId = sampleProject.pages[1]!.id;
    session.offlineNetworkGrants = [{ pageId: sampleProject.pages[1]!.id, origin: "https://assets.example.com" }];
    session.pageElapsedMs = 9_000;
    session.sectionElapsedMs = 12_000;
    const running = beginPresentationLaunch(sampleProject, session);
    const latest = { ...sampleProject, pages: sampleProject.pages.filter((_page, index) => index !== 1).map((page, order) => ({ ...page, order, section: order === 0 ? "已变更章节" : page.section })) };

    const applied = applyProjectToPresentation(running, latest);

    expect(applied.session.currentPageIndex).toBe(0);
    expect(applied.session.annotationTool).toBe("none");
    expect(applied.session.circles).toEqual([]);
    expect(applied.session.laser).toBeNull();
    expect(applied.session.offlineFallbackPageId).toBeNull();
    expect(applied.session.offlineNetworkGrants).toEqual([]);
    expect(applied.session.pageElapsedMs).toBe(0);
    expect(applied.session.sectionElapsedMs).toBe(0);
  });
});
