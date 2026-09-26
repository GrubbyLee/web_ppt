import type { Project } from "@showit/contracts";
import { loadWorkspace, saveWorkspace } from "./persistence";

export type PresenterPageEditKind = "script" | "url" | "masks" | "autoAdvance";
export type PresenterProjectEditKind = "layout" | "autoAdvance";

export type PresenterEditScope = {
  pageEdits: Record<string, PresenterPageEditKind[]>;
  projectEdits: PresenterProjectEditKind[];
};

export const emptyPresenterEditScope: PresenterEditScope = { pageEdits: {}, projectEdits: [] };

export function hasPresenterEdits(scope: PresenterEditScope): boolean {
  return scope.projectEdits.length > 0 || Object.values(scope.pageEdits).some((edits) => edits.length > 0);
}

/**
 * Merge live edits made in the presenter back into the stored project.
 * `target` (the editor's copy) wins for untouched fields; `source` (the
 * runtime copy) wins for every field the presenter actually edited, so a
 * concurrent editor change to another field is never clobbered.
 */
export function mergeProjectEdits(target: Project, source: Project, scope: PresenterEditScope): Project {
  if (!hasPresenterEdits(scope)) return target;
  const pages = target.pages.map((page): Project["pages"][number] => {
    const edits = scope.pageEdits[page.id];
    if (!edits?.length) return page;
    const sourcePage = source.pages.find((item) => item.id === page.id);
    if (!sourcePage) return page;
    let merged: Project["pages"][number] = page;
    if (edits.includes("script")) merged = { ...merged, script: sourcePage.script };
    if (edits.includes("url")) {
      const { url: _dropped, ...withoutUrl } = merged;
      merged = sourcePage.url ? { ...withoutUrl, url: sourcePage.url } : withoutUrl;
    }
    if (edits.includes("masks")) merged = { ...merged, privacyMasks: sourcePage.privacyMasks };
    if (edits.includes("autoAdvance")) {
      const { autoAdvanceSeconds: _dropped, ...withoutOverride } = merged;
      merged = sourcePage.autoAdvanceSeconds === undefined ? withoutOverride : { ...withoutOverride, autoAdvanceSeconds: sourcePage.autoAdvanceSeconds };
    }
    return merged;
  });
  let project: Project = { ...target, pages };
  if (scope.projectEdits.includes("layout")) project = { ...project, layout: source.layout };
  if (scope.projectEdits.includes("autoAdvance")) {
    project = { ...project, autoAdvanceEnabled: source.autoAdvanceEnabled, autoAdvanceSeconds: source.autoAdvanceSeconds };
  }
  return project;
}

/**
 * Persist presenter-time edits into the project library on exit. Returns true
 * when the stored workspace was rewritten. The stored session is preserved —
 * only project content is merged. Missing workspaces (deleted mid-run) are
 * skipped silently: there is nothing left to merge into.
 */
export async function mergePresenterEditsIntoWorkspace(runtimeProject: Project, scope: PresenterEditScope): Promise<boolean> {
  if (!hasPresenterEdits(scope)) return false;
  const stored = await loadWorkspace(runtimeProject.id);
  if (!stored || stored.project.id !== runtimeProject.id) return false;
  const merged = mergeProjectEdits(stored.project, runtimeProject, scope);
  await saveWorkspace({ ...stored, project: merged });
  return true;
}
