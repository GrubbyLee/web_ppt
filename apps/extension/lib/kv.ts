/**
 * Async key-value adapter shared by every extension context.
 *
 * - In the service worker and extension pages it wraps `chrome.storage.local`.
 * - In tests (and any plain browser without the extension APIs) it falls back
 *   to an in-memory map so the pure logic stays runnable outside Chrome.
 *
 * Never import this from code that runs inside the business tab content
 * script — content scripts have no `chrome.storage` of their own.
 */

type StorageArea = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

const memory = new Map<string, unknown>();

function chromeArea(): StorageArea | null {
  const area = (globalThis as { chrome?: { storage?: { local?: StorageArea } } }).chrome?.storage?.local;
  return area && typeof area.get === "function" && typeof area.set === "function" ? area : null;
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const area = chromeArea();
  if (!area) return (memory.get(key) as T | undefined) ?? null;
  try {
    const stored = await area.get([key]);
    return (stored[key] as T | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const area = chromeArea();
  if (!area) {
    memory.set(key, value);
    return;
  }
  await area.set({ [key]: value });
}

export async function kvRemove(key: string): Promise<void> {
  const area = chromeArea();
  if (!area) {
    memory.delete(key);
    return;
  }
  await area.remove([key]);
}

/** chrome.storage.session wrapper: in-memory in the browser, cleared when the
 *  browser exits. Used for crash-recovery snapshots that must not touch disk. */
const sessionMemory = new Map<string, unknown>();

type SessionArea = StorageArea;

function chromeSessionArea(): SessionArea | null {
  const area = (globalThis as { chrome?: { storage?: { session?: SessionArea } } }).chrome?.storage?.session;
  return area && typeof area.get === "function" ? area : null;
}

export async function kvSessionGet<T>(key: string): Promise<T | null> {
  const area = chromeSessionArea();
  if (!area) return (sessionMemory.get(key) as T | undefined) ?? null;
  try {
    const stored = await area.get([key]);
    return (stored[key] as T | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function kvSessionSet(key: string, value: unknown): Promise<void> {
  const area = chromeSessionArea();
  if (!area) {
    sessionMemory.set(key, value);
    return;
  }
  await area.set({ [key]: value });
}

export async function kvSessionRemove(key: string): Promise<void> {
  const area = chromeSessionArea();
  if (!area) {
    sessionMemory.delete(key);
    return;
  }
  await area.remove([key]);
}

/** Test hook: wipe the in-memory fallbacks between unit tests. */
export function resetMemoryStorageForTests(): void {
  memory.clear();
  sessionMemory.clear();
}
