import { rm } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Profile directory for a Playwright persistent context (extensions are only
 * loadable that way).
 *
 * The directory is wiped before every run. A profile that survives between runs
 * leaks state — restored session snapshots, extension storage, window geometry
 * — and produced false failures: stale page counters ("1/18" not showing) and
 * "Unable to capture screenshot" on a backgrounded window. Starting clean makes
 * a local run behave exactly like CI.
 *
 * Set SHOWIT_E2E_KEEP_PROFILE=1 to keep the previous profile when you need to
 * inspect what a failing run left behind.
 */
export async function freshProfileDir(name) {
  const directory = resolve(import.meta.dirname, "..", "test-results", name);
  if (!process.env.SHOWIT_E2E_KEEP_PROFILE) await rm(directory, { recursive: true, force: true });
  return directory;
}
