import { afterEach, describe, expect, it } from "vitest";
import { createProject } from "./project-workspace";
import { clearProjectDraft, loadProjectDraft, saveProjectDraft } from "./project-draft";

describe("editor draft recovery", () => {
  const projectId = "draft-project";
  afterEach(() => clearProjectDraft(projectId));

  it("restores a valid unsaved project without accepting runtime secret values", () => {
    const project = { ...createProject("草稿"), id: projectId, name: "未保存名称" };
    saveProjectDraft(project);
    expect(loadProjectDraft(projectId)?.name).toBe("未保存名称");
    localStorage.setItem(`showit:editor-draft:v1:${projectId}`, JSON.stringify({ ...project, sensitiveVariables: [{ key: "apiToken", label: "API Token", required: true, expiresAfterMinutes: 60, value: "secret" }] }));
    expect(loadProjectDraft(projectId)).toBeNull();
  });
});
