import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { recordExternalDiagnostic } from "./diagnostics";
import {
  PresentationSessionSchema,
  ProjectSchema,
  ProjectVersionSchema,
  RehearsalSchema,
  type PresentationSession,
  type PresentationConnector,
  type Project,
  type ProjectVersion,
  type Rehearsal
} from "@showit/contracts";
import { createRemoteAudienceSnapshot } from "./remote-audience-snapshot";

const LEGACY_STORAGE_KEY = "showit:workspace:v1";
const LIBRARY_STORAGE_KEY = "showit:library:v1";
const ACTIVE_PROJECT_KEY = "showit:active-project:v1";
const VERSION_STORAGE_KEY = "showit:versions:v1";
const REHEARSAL_STORAGE_KEY = "showit:rehearsals:v1";

export type Workspace = {
  project: Project;
  session: PresentationSession;
};

export type AudienceShare = {
  url: string;
  localUrl: string;
  signalUrl: string;
  sessionId: string;
  token: string;
  networkName: string;
  networkAddress: string;
  deliveryMode: "p2p" | "sfu";
  sfuUrl: string | null;
  sfuToken: string | null;
};

export type AudienceNetworkInterface = {
  name: string;
  address: string;
  isDefault: boolean;
};

export type AudienceSessionStatus = {
  audienceCount: number;
  capacity: number;
  viewers: AudienceViewer[];
};

export type AudienceViewer = {
  id: string;
  displayName: string;
  ip: string;
  requestedAt: number;
  status: "pending" | "approved" | "connected";
  quality: "waiting" | "good" | "fair" | "poor";
};

export type BusinessUrlHealth = {
  ok: boolean;
  status: number | null;
  elapsedMs: number;
  error: string | null;
  mode: "tauri" | "browser";
};

export type BrowserProfileStatus = { exists: boolean; bytes: number };
export type ReadonlyProxyTarget = { url: string };

export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function sendExtensionMessage(message: Record<string, unknown>): Promise<number> {
  if (!inTauri()) return 0;
  return invoke<number>("send_extension_message", { message });
}

export async function listenExtensionMessages(handler: (message: unknown) => void): Promise<UnlistenFn | null> {
  if (!inTauri()) return null;
  return listen<unknown>("showit://extension", (event) => {
    const payload = event.payload as { type?: unknown } | null;
    if (payload?.type === "extension-diagnostic") {
      recordExternalDiagnostic(event.payload, "浏览器扩展");
    }
    handler(event.payload);
  });
}

export async function listenAudienceWindowClosed(sessionId: string, handler: () => void): Promise<UnlistenFn | null> {
  if (!inTauri()) return null;
  return listen<{ sessionId?: unknown }>("showit://audience-window-closed", (event) => {
    if (event.payload?.sessionId === sessionId) handler();
  });
}

export async function focusMainWindow(): Promise<void> {
  if (!inTauri()) return;
  await invoke("focus_main_window");
}

export async function checkBusinessUrl(url: string): Promise<BusinessUrlHealth> {
  if (inTauri()) {
    const result = await invoke<Omit<BusinessUrlHealth, "mode">>("check_business_url", { url });
    return { ...result, mode: "tauri" };
  }
  const started = performance.now();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, { method: "GET", credentials: "omit", cache: "no-store", signal: controller.signal });
    return { ok: response.ok, status: response.status, elapsedMs: Math.round(performance.now() - started), error: null, mode: "browser" };
  } catch (error) {
    return {
      ok: false,
      status: null,
      elapsedMs: Math.round(performance.now() - started),
      error: error instanceof DOMException && error.name === "AbortError" ? "业务页面加载超时" : "浏览器开发模式受跨域策略限制",
      mode: "browser"
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function openBusinessBrowser(url: string, projectId: string, dedicated: boolean): Promise<string> {
  if (inTauri()) return invoke<string>("open_business_browser", { url, projectId, dedicated });
  window.open(url, dedicated ? `showit-dedicated-${projectId}` : "_blank", "popup,width=1280,height=800");
  return dedicated ? "browser-development" : "default";
}

export async function getDedicatedBrowserProfileStatus(projectId: string): Promise<BrowserProfileStatus> {
  if (!inTauri()) return { exists: false, bytes: 0 };
  return invoke<BrowserProfileStatus>("dedicated_browser_profile_status", { projectId });
}

export async function clearDedicatedBrowserProfile(projectId: string): Promise<void> {
  if (!inTauri()) return;
  await invoke("clear_dedicated_browser_profile", { projectId });
}

function parseWorkspace(value: unknown): Workspace | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { project?: unknown; session?: unknown };
  const project = ProjectSchema.safeParse(candidate.project);
  const session = PresentationSessionSchema.safeParse(candidate.session);
  if (!project.success || !session.success || project.data.id !== session.data.projectId) return null;
  return { project: project.data, session: session.data };
}

function readBrowserLibrary(): Workspace[] {
  try {
    const stored = JSON.parse(localStorage.getItem(LIBRARY_STORAGE_KEY) ?? "[]");
    const workspaces = Array.isArray(stored) ? stored.map(parseWorkspace).filter((item): item is Workspace => item !== null) : [];
    if (workspaces.length > 0) return workspaces;

    const legacy = parseWorkspace(JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? "null"));
    return legacy ? [legacy] : [];
  } catch {
    return [];
  }
}

function writeBrowserLibrary(workspaces: Workspace[]): void {
  localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(workspaces));
}

export async function listWorkspaces(): Promise<Workspace[]> {
  if (inTauri()) {
    try {
      const saved = await invoke<unknown[]>("list_workspaces");
      const parsed = saved.map(parseWorkspace).filter((item): item is Workspace => item !== null);
      if (parsed.length > 0) return parsed;
    } catch {
      // Browser storage remains a recovery path if desktop persistence is unavailable.
    }
  }

  return readBrowserLibrary();
}

export async function loadWorkspace(projectId?: string): Promise<Workspace | null> {
  if (inTauri()) {
    try {
      const saved = await invoke<unknown>("load_workspace", { projectId: projectId ?? null });
      const parsed = parseWorkspace(saved);
      if (parsed) return parsed;
    } catch {
      // Browser storage remains a recovery path if desktop persistence is unavailable.
    }
  }

  const workspaces = readBrowserLibrary();
  const activeProjectId = projectId ?? localStorage.getItem(ACTIVE_PROJECT_KEY);
  return workspaces.find((item) => item.project.id === activeProjectId) ?? workspaces[0] ?? null;
}

export async function saveWorkspace(workspace: Workspace): Promise<void> {
  const workspaces = readBrowserLibrary();
  const existingIndex = workspaces.findIndex((item) => item.project.id === workspace.project.id);
  if (existingIndex >= 0) workspaces[existingIndex] = workspace;
  else workspaces.unshift(workspace);
  if (inTauri()) {
    await invoke("save_workspace", { workspace });
    try {
      writeBrowserLibrary(workspaces);
      localStorage.setItem(ACTIVE_PROJECT_KEY, workspace.project.id);
    } catch {
      // SQLite is the source of truth in Tauri; browser cache is best-effort only.
    }
    return;
  }
  writeBrowserLibrary(workspaces);
  localStorage.setItem(ACTIVE_PROJECT_KEY, workspace.project.id);
}

export async function saveRuntimeSession(workspace: Workspace): Promise<void> {
  if (!inTauri()) return;
  await invoke("save_runtime_session", { workspace });
}

export async function loadRuntimeSession(projectId: string): Promise<Workspace | null> {
  if (!inTauri()) return null;
  return parseWorkspace(await invoke<unknown>("load_runtime_session", { projectId }));
}

export async function clearRuntimeSession(projectId: string): Promise<void> {
  if (!inTauri()) return;
  await invoke("clear_runtime_session", { projectId });
}

export async function configureReadonlyProxy(projectId: string, connector: PresentationConnector, pageUrl: string): Promise<string> {
  if (!inTauri()) throw new Error("只读代理仅在 Showit 桌面客户端中可用。");
  const target = await invoke<ReadonlyProxyTarget>("configure_readonly_proxy", {
    projectId,
    origin: connector.origin,
    pageUrl,
    loginPaths: connector.loginPaths,
    logoutPaths: connector.logoutPaths,
    requestHeaders: connector.requestHeaders
  });
  return target.url;
}

export async function clearReadonlyProxy(projectId: string): Promise<void> {
  if (!inTauri()) return;
  await invoke("clear_readonly_proxy", { projectId });
}

export async function deleteWorkspace(projectId: string): Promise<void> {
  if (inTauri()) {
    await invoke("delete_workspace", { projectId });
    await invoke("clear_runtime_session", { projectId });
  }
  writeBrowserLibrary(readBrowserLibrary().filter((item) => item.project.id !== projectId));
  if (localStorage.getItem(ACTIVE_PROJECT_KEY) === projectId) localStorage.removeItem(ACTIVE_PROJECT_KEY);
}

export function setActiveProject(projectId: string): void {
  localStorage.setItem(ACTIVE_PROJECT_KEY, projectId);
}

function parseStoredArray<T>(key: string, parse: (value: unknown) => T | null): T[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(values) ? values.map(parse).filter((value): value is T => value !== null) : [];
  } catch {
    return [];
  }
}

export async function listProjectVersions(projectId: string): Promise<ProjectVersion[]> {
  if (inTauri()) {
    try {
      const values = await invoke<unknown[]>("list_project_versions", { projectId });
      return values.map((value) => ProjectVersionSchema.safeParse(value)).filter((result) => result.success).map((result) => result.data);
    } catch {
      // Fall through to browser recovery storage.
    }
  }
  return parseStoredArray(VERSION_STORAGE_KEY, (value) => {
    const parsed = ProjectVersionSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }).filter((version) => version.projectId === projectId).sort((a, b) => b.version - a.version);
}

export async function createProjectSnapshot(project: Project, changeSummary: string, kind: ProjectVersion["kind"]): Promise<ProjectVersion> {
  if (inTauri()) {
    const value = await invoke<unknown>("publish_project_version", { project, changeSummary, kind });
    return ProjectVersionSchema.parse(value);
  }
  const versions = parseStoredArray(VERSION_STORAGE_KEY, (value) => {
    const parsed = ProjectVersionSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
  const nextVersion = Math.max(0, ...versions.filter((item) => item.projectId === project.id).map((item) => item.version)) + 1;
  const version: ProjectVersion = {
    id: `version-${Date.now().toString(36)}-${nextVersion}`,
    projectId: project.id,
    version: nextVersion,
    kind,
    createdAt: Date.now(),
    changeSummary,
    snapshot: project
  };
  const nextVersions = [version, ...versions];
  const retainedAutoIds = new Set(nextVersions.filter((item) => item.projectId === project.id && item.kind === "auto").slice(0, 30).map((item) => item.id));
  localStorage.setItem(VERSION_STORAGE_KEY, JSON.stringify(nextVersions.filter((item) => item.projectId !== project.id || item.kind !== "auto" || retainedAutoIds.has(item.id))));
  return version;
}

export function publishProjectVersion(project: Project, changeSummary = "发布项目"): Promise<ProjectVersion> {
  return createProjectSnapshot(project, changeSummary, "publish");
}

export async function listRehearsals(projectId: string): Promise<Rehearsal[]> {
  if (inTauri()) {
    try {
      const values = await invoke<unknown[]>("list_rehearsals", { projectId });
      return values.map((value) => RehearsalSchema.safeParse(value)).filter((result) => result.success).map((result) => result.data);
    } catch {
      // Fall through to browser recovery storage.
    }
  }
  return parseStoredArray(REHEARSAL_STORAGE_KEY, (value) => {
    const parsed = RehearsalSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }).filter((rehearsal) => rehearsal.projectId === projectId).sort((a, b) => b.endedAt - a.endedAt).slice(0, 5);
}

export async function saveRehearsal(rehearsal: Rehearsal): Promise<void> {
  const validated = RehearsalSchema.parse(rehearsal);
  const rehearsals = parseStoredArray(REHEARSAL_STORAGE_KEY, (value) => {
    const parsed = RehearsalSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
  localStorage.setItem(REHEARSAL_STORAGE_KEY, JSON.stringify([validated, ...rehearsals].slice(0, 100)));
  if (!inTauri()) return;
  await invoke("save_rehearsal", { rehearsal: validated });
}

export async function openAudienceWindow(sessionId: string): Promise<void> {
  if (inTauri()) {
    await invoke("open_audience_window", { sessionId });
    return;
  }
  const route = `${window.location.origin}${window.location.pathname}#/audience/${sessionId}`;
  window.open(route, "showit-audience", "popup,width=1440,height=900");
}

export async function listAudienceNetworkInterfaces(): Promise<AudienceNetworkInterface[]> {
  if (inTauri()) return invoke<AudienceNetworkInterface[]>("audience_network_interfaces");
  return [{ name: "浏览器开发模式", address: "127.0.0.1", isDefault: true }];
}

export async function startAudienceSession(project: Project, session: PresentationSession, networkAddress?: string): Promise<AudienceShare> {
  if (inTauri()) {
    return invoke<AudienceShare>("start_audience_session", { sessionId: session.id, snapshot: createRemoteAudienceSnapshot(project, session), networkAddress });
  }
  const url = `${window.location.origin}${window.location.pathname}#/audience/${session.id}`;
  return {
    url,
    localUrl: url,
    signalUrl: "",
    sessionId: session.id,
    token: "browser-development",
    networkName: "浏览器开发模式",
    networkAddress: "127.0.0.1",
    deliveryMode: "p2p",
    sfuUrl: null,
    sfuToken: null
  };
}

export async function publishAudienceSession(project: Project, session: PresentationSession): Promise<void> {
  if (!inTauri()) return;
  await invoke("publish_audience_session", { sessionId: session.id, snapshot: createRemoteAudienceSnapshot(project, session) });
}

export async function stopAudienceSession(sessionId: string): Promise<void> {
  if (!inTauri()) return;
  await invoke("stop_audience_session", { sessionId });
}

export async function getAudienceSessionStatus(sessionId: string): Promise<AudienceSessionStatus | null> {
  if (!inTauri()) return null;
  return invoke<AudienceSessionStatus | null>("audience_session_status", { sessionId });
}

export async function decideAudienceViewer(sessionId: string, viewerId: string, approve: boolean): Promise<void> {
  if (!inTauri()) return;
  await invoke("decide_audience_viewer", { sessionId, viewerId, approve });
}

export async function disconnectAudienceViewer(sessionId: string, viewerId: string): Promise<void> {
  if (!inTauri()) return;
  await invoke("disconnect_audience_viewer", { sessionId, viewerId });
}

export async function disconnectAllAudienceViewers(sessionId: string): Promise<void> {
  if (!inTauri()) return;
  await invoke("disconnect_all_audience_viewers", { sessionId });
}
