import { ProjectSchema, type Project } from "@showit/contracts";

const key = (projectId: string) => `showit:editor-draft:v1:${projectId}`;

export function saveProjectDraft(project: Project): void {
  const parsed = ProjectSchema.safeParse(project);
  if (!parsed.success) return;
  localStorage.setItem(key(project.id), JSON.stringify(parsed.data));
}

export function loadProjectDraft(projectId: string): Project | null {
  try {
    const parsed = ProjectSchema.safeParse(JSON.parse(localStorage.getItem(key(projectId)) ?? "null"));
    return parsed.success && parsed.data.id === projectId ? parsed.data : null;
  } catch {
    return null;
  }
}

export function clearProjectDraft(projectId: string): void {
  localStorage.removeItem(key(projectId));
}
