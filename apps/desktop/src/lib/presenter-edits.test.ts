import { afterEach, describe, expect, it } from "vitest";
import { sampleProject } from "./sample-project";
import { createProject, createSession } from "./project-workspace";
import { listWorkspaces, loadWorkspace, saveWorkspace } from "./persistence";
import { hasPresenterEdits, mergePresenterEditsIntoWorkspace, mergeProjectEdits, type PresenterEditScope } from "./presenter-edits";

describe("presenter edit merge", () => {
  afterEach(() => localStorage.clear());

  it("merges only the fields the presenter actually edited", () => {
    const stored = structuredClone(sampleProject);
    const runtime = structuredClone(sampleProject);
    runtime.pages[0]!.script = { ...runtime.pages[0]!.script, markdown: "现场修改的脚本" };
    stored.pages[0]!.url = "https://editor.example.com/changed";
    const scope: PresenterEditScope = { pageEdits: { [stored.pages[0]!.id]: ["script"] }, projectEdits: [] };
    const merged = mergeProjectEdits(stored, runtime, scope);
    expect(merged.pages[0]!.script.markdown).toBe("现场修改的脚本");
    // Untouched fields keep the editor's (target) version.
    expect(merged.pages[0]!.url).toBe("https://editor.example.com/changed");
    expect(merged.pages[1]).toEqual(stored.pages[1]);
  });

  it("propagates cleared URLs and per-page auto-advance overrides", () => {
    const stored = structuredClone(sampleProject);
    const runtime = structuredClone(sampleProject);
    delete runtime.pages[0]!.url;
    runtime.pages[1]!.autoAdvanceSeconds = 30;
    const scope: PresenterEditScope = {
      pageEdits: { [stored.pages[0]!.id]: ["url"], [stored.pages[1]!.id]: ["autoAdvance"] },
      projectEdits: []
    };
    const merged = mergeProjectEdits(stored, runtime, scope);
    expect(merged.pages[0]!.url).toBeUndefined();
    expect(merged.pages[1]!.autoAdvanceSeconds).toBe(30);
  });

  it("applies layout and auto-advance project edits", () => {
    const stored = structuredClone(sampleProject);
    const runtime = structuredClone(sampleProject);
    runtime.layout = { ...runtime.layout, preset: "notes", stagePercent: 54 };
    runtime.autoAdvanceEnabled = !stored.autoAdvanceEnabled;
    runtime.autoAdvanceSeconds = stored.autoAdvanceSeconds + 5;
    const scope: PresenterEditScope = { pageEdits: {}, projectEdits: ["layout", "autoAdvance"] };
    const merged = mergeProjectEdits(stored, runtime, scope);
    expect(merged.layout).toEqual(runtime.layout);
    expect(merged.autoAdvanceEnabled).toBe(runtime.autoAdvanceEnabled);
    expect(merged.autoAdvanceSeconds).toBe(runtime.autoAdvanceSeconds);
  });

  it("leaves the stored project untouched without edits", () => {
    const stored = structuredClone(sampleProject);
    const runtime = structuredClone(sampleProject);
    runtime.pages[0]!.script = { ...runtime.pages[0]!.script, markdown: "不会合并" };
    expect(hasPresenterEdits({ pageEdits: {}, projectEdits: [] })).toBe(false);
    expect(mergeProjectEdits(stored, runtime, { pageEdits: {}, projectEdits: [] })).toBe(stored);
  });

  it("merges live edits into the stored workspace on exit and keeps its session", async () => {
    const project = createProject("合并退出");
    const storedSession = createSession(project);
    await saveWorkspace({ project, session: storedSession });
    const runtime = structuredClone(project);
    runtime.pages[0]!.script = { ...runtime.pages[0]!.script, markdown: "退出前修改" };
    runtime.layout = { ...runtime.layout, stagePercent: 70 };
    const scope: PresenterEditScope = { pageEdits: { [project.pages[0]!.id]: ["script"] }, projectEdits: ["layout"] };
    expect(await mergePresenterEditsIntoWorkspace(runtime, scope)).toBe(true);
    const merged = await loadWorkspace(project.id);
    expect(merged?.project.pages[0]?.script.markdown).toBe("退出前修改");
    expect(merged?.project.layout.stagePercent).toBe(70);
    expect(merged?.session).toEqual(storedSession);
    // A second exit without new edits must not rewrite anything.
    expect(await mergePresenterEditsIntoWorkspace(runtime, { pageEdits: {}, projectEdits: [] })).toBe(false);
  });

  it("skips merging when the stored workspace disappeared", async () => {
    const project = createProject("已删除项目");
    const runtime = structuredClone(project);
    const scope: PresenterEditScope = { pageEdits: { [project.pages[0]!.id]: ["script"] }, projectEdits: [] };
    expect(await mergePresenterEditsIntoWorkspace(runtime, scope)).toBe(false);
    expect(await listWorkspaces()).toHaveLength(0);
  });
});
