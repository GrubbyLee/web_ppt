import { describe, expect, it } from "vitest";
import { sampleProject } from "./sample-project";
import { createSession } from "./project-workspace";
import { applyProjectToPresentation, beginPresentationLaunch } from "./presentation-launch";

describe("presentation launch snapshot", () => {
  it("keeps an isolated startup project", () => {
    const launch = beginPresentationLaunch(sampleProject);
    const originalName = launch.project.name;
    launch.project.name = "运行时副本";
    expect(beginPresentationLaunch(sampleProject).project.name).toBe(originalName);
  });

  it("starts every run from the first page with a clean timer", () => {
    // 上一场停在末页、计时跑了一段、步骤完成过——再点「运行」必须是一场新的。
    const finished = createSession(sampleProject);
    finished.currentPageIndex = sampleProject.pages.length - 1;
    finished.completedStepIds = [sampleProject.pages[0]!.script.steps[0]!.id];
    finished.timerStatus = "paused";
    finished.totalElapsedMs = 600_000;
    finished.pageElapsedMs = 30_000;

    const launch = beginPresentationLaunch(sampleProject);

    expect(launch.session.currentPageIndex).toBe(0);
    expect(launch.session.completedStepIds).toEqual([]);
    expect(launch.session.timerStatus).toBe("idle");
    expect(launch.session.totalElapsedMs).toBe(0);
    expect(launch.session.pageElapsedMs).toBe(0);
    expect(launch.session.screenMode).toBe("normal");
    expect(launch.session.audienceStatus).toBe("disconnected");
    expect(launch.session.audienceCount).toBe(0);
  });

  it("ignores the persisted session entirely (no 演示结束 state leaks in)", () => {
    const finished = createSession(sampleProject);
    finished.screenMode = "ended";
    finished.audienceStatus = "synced";
    finished.audienceCount = 3;
    const launch = beginPresentationLaunch(sampleProject);
    expect(launch.session.screenMode).toBe("normal");
    expect(launch.session.audienceStatus).toBe("disconnected");
    expect(launch.session.audienceCount).toBe(0);
    expect(launch.session.id).not.toBe(finished.id);
  });

  it("excludes disabled pages from a running snapshot", () => {
    const project = { ...sampleProject, pages: sampleProject.pages.map((page, index) => ({ ...page, enabled: index !== 1 })) };
    const launch = beginPresentationLaunch(project);
    expect(launch.project.pages).toHaveLength(sampleProject.pages.length - 1);
    expect(launch.project.pages.every((page) => page.enabled)).toBe(true);
    expect(launch.project.pages.map((page) => page.order)).toEqual(launch.project.pages.map((_page, index) => index));
  });

  it("applies editor changes only through an explicit merge", () => {
    const running = beginPresentationLaunch(sampleProject);
    running.session.currentPageIndex = 1;
    running.session.completedStepIds = [sampleProject.pages[0]!.script.steps[0]!.id, "removed-step"];
    const latest = { ...sampleProject, name: "编辑后的项目", pages: sampleProject.pages.map((page) => ({ ...page })) };
    expect(running.project.name).toBe(sampleProject.name);
    const applied = applyProjectToPresentation(running, latest);
    expect(applied.project.name).toBe("编辑后的项目");
    expect(applied.session.currentPageIndex).toBe(1);
    expect(applied.session.completedStepIds).not.toContain("removed-step");
  });

  it("moves onto the next enabled page and drops the disabled page's state when the editor disables it", () => {
    const project = structuredClone(sampleProject);
    const running = beginPresentationLaunch(project);
    const disabledStepId = project.pages[1]!.script.steps[0]!.id;
    running.session.currentPageIndex = 1;
    running.session.completedStepIds = [disabledStepId];
    running.session.forcedStepCompletions = [{ stepId: disabledStepId, reason: "旧页面", at: Date.now() }];
    running.session.pendingHighRiskStepId = disabledStepId;
    running.session.offlineFallbackPageId = project.pages[1]!.id;
    running.session.offlineNetworkGrants = [{ pageId: project.pages[1]!.id, origin: "https://assets.example.com" }];
    running.session.annotationTool = "circle";
    running.session.circles = [{ id: "disabled-circle", x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.4 }];
    running.session.laser = { x: 0.3, y: 0.2, expiresAt: Date.now() + 1_000 };
    running.session.pageElapsedMs = 12_000;
    running.session.sectionElapsedMs = 16_000;

    const edited = structuredClone(sampleProject);
    edited.pages[1]!.enabled = false;
    const applied = applyProjectToPresentation(running, edited);

    expect(applied.project.pages.map((page) => page.id)).not.toContain(project.pages[1]!.id);
    expect(applied.project.pages[applied.session.currentPageIndex]?.id).toBe(project.pages[2]!.id);
    expect(applied.session.completedStepIds).toEqual([]);
    expect(applied.session.forcedStepCompletions).toEqual([]);
    expect(applied.session.pendingHighRiskStepId).toBeNull();
    expect(applied.session.offlineFallbackPageId).toBeNull();
    expect(applied.session.offlineNetworkGrants).toEqual([]);
    expect(applied.session.annotationTool).toBe("none");
    expect(applied.session.circles).toEqual([]);
    expect(applied.session.laser).toBeNull();
    expect(applied.session.pageElapsedMs).toBe(0);
    expect(applied.session.sectionElapsedMs).toBe(0);
  });

  it("returns to the first page when the disabled page has no enabled successor", () => {
    const running = beginPresentationLaunch(sampleProject);
    running.session.currentPageIndex = sampleProject.pages.length - 1;

    const edited = structuredClone(sampleProject);
    edited.pages[edited.pages.length - 1]!.enabled = false;
    const applied = applyProjectToPresentation(running, edited);

    expect(applied.session.currentPageIndex).toBe(0);
  });

  it("clears page-local state and advances when applying editor changes removes the current page", () => {
    const running = beginPresentationLaunch(sampleProject);
    running.session.currentPageIndex = 1;
    running.session.annotationTool = "circle";
    running.session.circles = [{ id: "removed-circle", x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.4 }];
    running.session.laser = { x: 0.2, y: 0.3, expiresAt: Date.now() + 1_000 };
    running.session.offlineFallbackPageId = sampleProject.pages[1]!.id;
    running.session.offlineNetworkGrants = [{ pageId: sampleProject.pages[1]!.id, origin: "https://assets.example.com" }];
    running.session.pageElapsedMs = 9_000;
    running.session.sectionElapsedMs = 12_000;
    const latest = { ...sampleProject, pages: sampleProject.pages.filter((_page, index) => index !== 1).map((page, order) => ({ ...page, order, section: order === 0 ? "已变更章节" : page.section })) };

    const applied = applyProjectToPresentation(running, latest);

    expect(applied.session.currentPageIndex).toBe(1);
    expect(applied.project.pages[applied.session.currentPageIndex]?.id).toBe(sampleProject.pages[2]!.id);
    expect(applied.session.annotationTool).toBe("none");
    expect(applied.session.circles).toEqual([]);
    expect(applied.session.laser).toBeNull();
    expect(applied.session.offlineFallbackPageId).toBeNull();
    expect(applied.session.offlineNetworkGrants).toEqual([]);
    expect(applied.session.pageElapsedMs).toBe(0);
    expect(applied.session.sectionElapsedMs).toBe(0);
  });
});
