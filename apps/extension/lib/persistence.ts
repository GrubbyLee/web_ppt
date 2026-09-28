import {
  PresentationSessionSchema,
  ProjectSchema,
  ProjectVersionSchema,
  RehearsalSchema,
  type PresentationSession,
  type Project,
  type ProjectVersion,
  type Rehearsal
} from "@showit/contracts";
import { kvGet, kvSet } from "./kv";
import { clearProjectDraft } from "./project-draft";
import { migrateLegacyBundledSample } from "./sample-project";
import { sampleProject } from "./sample-project";
import { createSession } from "./project-workspace";
import { trustProject } from "./project-trust";

const ORDER_STORAGE_KEY = "showit:library-order:v1";
const ACTIVE_PROJECT_KEY = "showit:active-project:v1";
const RUNTIME_SESSION_KEY = "showit:runtime-session:v1";

export type Workspace = {
  project: Project;
  session: PresentationSession;
};

type ObjectStoreLike = {
  put(value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  getAll(): Promise<unknown[]>;
  getAllFromIndex(indexName: string, key: string): Promise<unknown[]>;
};

type DatabaseLike = {
  transaction(storeNames: string[], mode: "readonly" | "readwrite"): {
    objectStore(name: string): ObjectStoreLike;
  };
};

const DATABASE_NAME = "showit";
const DATABASE_VERSION = 1;
const STORE_WORKSPACES = "workspaces";
const STORE_VERSIONS = "versions";
const STORE_REHEARSALS = "rehearsals";
const INDEX_PROJECT = "by-project";

let databasePromise: Promise<DatabaseLike | null> | null = null;

function openDatabase(): Promise<DatabaseLike | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_WORKSPACES)) database.createObjectStore(STORE_WORKSPACES, { keyPath: "project.id" });
      if (!database.objectStoreNames.contains(STORE_VERSIONS)) {
        const store = database.createObjectStore(STORE_VERSIONS, { keyPath: "id" });
        store.createIndex(INDEX_PROJECT, "projectId", { unique: false });
      }
      if (!database.objectStoreNames.contains(STORE_REHEARSALS)) {
        const store = database.createObjectStore(STORE_REHEARSALS, { keyPath: "id" });
        store.createIndex(INDEX_PROJECT, "projectId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(adaptDatabase(request.result));
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function getDatabase(): Promise<DatabaseLike | null> {
  if (!databasePromise) databasePromise = openDatabase();
  return databasePromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 请求失败。"));
  });
}

function makeStore(store: IDBObjectStore): ObjectStoreLike {
  return {
    put: (value) => requestToPromise(store.put(value as never)).then(() => undefined),
    delete: (key) => requestToPromise(store.delete(key as never)).then(() => undefined),
    getAll: () => requestToPromise(store.getAll()),
    getAllFromIndex: (indexName, key) => requestToPromise(store.index(indexName).getAll(key as never))
  };
}

function adaptDatabase(database: IDBDatabase): DatabaseLike {
  return {
    transaction(storeNames, mode) {
      const tx = database.transaction(storeNames, mode);
      return { objectStore: (name) => makeStore(tx.objectStore(name)) };
    }
  };
}

function parseWorkspace(value: unknown): Workspace | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { project?: unknown; session?: unknown };
  const project = ProjectSchema.safeParse(candidate.project);
  const session = PresentationSessionSchema.safeParse(candidate.session);
  if (!project.success || !session.success || project.data.id !== session.data.projectId) return null;
  return { project: project.data, session: session.data };
}

// ---- Fallback JSON store (tests / environments without IndexedDB) ----------

const fallbackStore = new Map<string, unknown[]>();

function fallbackList(store: string): unknown[] {
  return fallbackStore.get(store) ?? [];
}

async function storeGetAll(store: string): Promise<unknown[]> {
  const database = await getDatabase();
  if (!database) return fallbackList(store);
  return database.transaction([store], "readonly").objectStore(store).getAll();
}

async function storeGetAllByProject(store: string, projectId: string): Promise<unknown[]> {
  const database = await getDatabase();
  if (!database) return fallbackList(store).filter((item) => (item as { projectId?: string }).projectId === projectId);
  return database.transaction([store], "readonly").objectStore(store).getAllFromIndex(INDEX_PROJECT, projectId);
}

async function storePut(store: string, value: unknown): Promise<void> {
  const database = await getDatabase();
  if (!database) {
    const items = fallbackList(store).filter((item) => (item as { id?: string }).id !== (value as { id?: string }).id);
    fallbackStore.set(store, [value, ...items]);
    return;
  }
  await database.transaction([store], "readwrite").objectStore(store).put(value);
}

async function storePutWorkspace(workspace: Workspace): Promise<void> {
  const database = await getDatabase();
  if (!database) {
    const items = (fallbackList(STORE_WORKSPACES) as Workspace[]).filter((item) => item.project.id !== workspace.project.id);
    fallbackStore.set(STORE_WORKSPACES, [workspace, ...items]);
    return;
  }
  await database.transaction([STORE_WORKSPACES], "readwrite").objectStore(STORE_WORKSPACES).put(workspace);
}

async function storeDelete(store: string, key: string): Promise<void> {
  const database = await getDatabase();
  if (!database) {
    fallbackStore.set(store, fallbackList(store).filter((item) => (item as { project?: { id?: string }; id?: string }).project?.id !== key && (item as { id?: string }).id !== key));
    return;
  }
  await database.transaction([store], "readwrite").objectStore(store).delete(key);
}

async function storeDeleteByProject(store: string, projectId: string): Promise<void> {
  const items = await storeGetAllByProject(store, projectId);
  for (const item of items) {
    const id = (item as { id?: string }).id;
    if (id) await storeDelete(store, id);
  }
}

export function resetPersistenceForTests(): void {
  fallbackStore.clear();
  databasePromise = null;
}

// ---- Library ----------------------------------------------------------------

async function readOrder(): Promise<string[]> {
  const order = await kvGet<string[]>(ORDER_STORAGE_KEY);
  return Array.isArray(order) ? order : [];
}

async function writeOrder(order: string[]): Promise<void> {
  await kvSet(ORDER_STORAGE_KEY, order);
}

async function migrateBundledWorkspace(workspace: Workspace | null): Promise<Workspace | null> {
  if (!workspace) return null;
  const project = migrateLegacyBundledSample(workspace.project);
  if (!project) return workspace;
  const migrated = { ...workspace, project };
  await trustProject(project);
  return migrated;
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const stored = await storeGetAll(STORE_WORKSPACES);
  const parsed = stored.map(parseWorkspace).filter((item): item is Workspace => item !== null);
  const migrated = await Promise.all(parsed.map(migrateBundledWorkspace)) as Workspace[];
  const order = await readOrder();
  const byId = new Map(migrated.map((workspace) => [workspace.project.id, workspace]));
  const ordered: Workspace[] = [];
  for (const id of order) {
    const workspace = byId.get(id);
    if (workspace) {
      ordered.push(workspace);
      byId.delete(id);
    }
  }
  return [...ordered, ...byId.values()];
}

export async function loadWorkspace(projectId?: string): Promise<Workspace | null> {
  const workspaces = await listWorkspaces();
  const targetId = projectId ?? (await kvGet<string>(ACTIVE_PROJECT_KEY)) ?? undefined;
  const workspace = workspaces.find((item) => item.project.id === targetId) ?? workspaces[0] ?? null;
  return migrateBundledWorkspace(workspace);
}

export async function saveWorkspace(workspace: Workspace): Promise<void> {
  await storePutWorkspace(workspace);
  const order = await readOrder();
  if (!order.includes(workspace.project.id)) await writeOrder([workspace.project.id, ...order]);
  await kvSet(ACTIVE_PROJECT_KEY, workspace.project.id);
}

export async function deleteWorkspace(projectId: string): Promise<void> {
  await storeDelete(STORE_WORKSPACES, projectId);
  await writeOrder((await readOrder()).filter((id) => id !== projectId));
  if ((await kvGet<string>(ACTIVE_PROJECT_KEY)) === projectId) await kvSet(ACTIVE_PROJECT_KEY, null);
  // A "此操作无法恢复" delete must not leave drafts, versions or rehearsal
  // history behind — a re-imported project with the same id would otherwise
  // inherit (or be silently overwritten by) the deleted project's data.
  clearProjectDraft(projectId);
  await storeDeleteByProject(STORE_VERSIONS, projectId);
  await storeDeleteByProject(STORE_REHEARSALS, projectId);
}

export async function setActiveProject(projectId: string): Promise<void> {
  await kvSet(ACTIVE_PROJECT_KEY, projectId);
}

/** First-run helper: seed the LCAPIM sample project when the library is empty. */
export async function ensureSampleWorkspace(): Promise<Workspace | null> {
  const existing = await listWorkspaces();
  if (existing.length > 0) return null;
  const workspace = { project: sampleProject, session: createSession(sampleProject) };
  await storePutWorkspace(workspace);
  await writeOrder([sampleProject.id]);
  await trustProject(sampleProject);
  return workspace;
}

// ---- Versions ---------------------------------------------------------------

export async function listProjectVersions(projectId: string): Promise<ProjectVersion[]> {
  const values = await storeGetAllByProject(STORE_VERSIONS, projectId);
  return values
    .map((value) => ProjectVersionSchema.safeParse(value))
    .filter((result) => result.success)
    .map((result) => result.data)
    .sort((a, b) => b.version - a.version);
}

export async function createProjectSnapshot(project: Project, changeSummary: string, kind: ProjectVersion["kind"], publishedBy = ""): Promise<ProjectVersion> {
  const versions = await listProjectVersions(project.id);
  const nextVersion = Math.max(0, ...versions.map((item) => item.version)) + 1;
  const version: ProjectVersion = {
    id: `version-${Date.now().toString(36)}-${nextVersion}`,
    projectId: project.id,
    version: nextVersion,
    kind,
    createdAt: Date.now(),
    publishedBy: publishedBy.trim().slice(0, 120),
    changeSummary,
    snapshot: project
  };
  await storePut(STORE_VERSIONS, version);
  // Retain only the 30 most recent automatic snapshots per project.
  const autoVersions = versions.filter((item) => item.kind === "auto");
  for (const stale of autoVersions.slice(30)) await storeDelete(STORE_VERSIONS, stale.id);
  return version;
}

export function publishProjectVersion(project: Project, changeSummary = "发布项目", publishedBy = ""): Promise<ProjectVersion> {
  return createProjectSnapshot(project, changeSummary, "publish", publishedBy);
}

// ---- Rehearsals ---------------------------------------------------------------

export async function listRehearsals(projectId: string): Promise<Rehearsal[]> {
  const values = await storeGetAllByProject(STORE_REHEARSALS, projectId);
  return values
    .map((value) => RehearsalSchema.safeParse(value))
    .filter((result) => result.success)
    .map((result) => result.data)
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, 5);
}

export async function saveRehearsal(rehearsal: Rehearsal): Promise<void> {
  const validated = RehearsalSchema.parse(rehearsal);
  await storePut(STORE_REHEARSALS, validated);
  const all = await storeGetAllByProject(STORE_REHEARSALS, validated.projectId);
  const stale = all
    .map((value) => RehearsalSchema.safeParse(value))
    .filter((result) => result.success)
    .map((result) => result.data)
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(100);
  for (const item of stale) await storeDelete(STORE_REHEARSALS, item.id);
}
