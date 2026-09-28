import type { Project } from "@showit/contracts";
import { fingerprintProject } from "./project-workspace";
import { requestedOfflineOrigins } from "./offline-package";
import { kvGet, kvRemove, kvSet } from "./kv";

const trustStorageKey = "showit:project-trust:v1";

export type ProjectImportReview = {
  origins: string[];
  offlineHtmlPages: number;
  automatedConnectors: number;
  highRiskSteps: number;
  embeddedBytes: number;
};

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.replace(/{{[^}]+}}/g, "showit-value")).origin;
  } catch {
    return null;
  }
}

export function inspectProjectImport(project: Project): ProjectImportReview {
  const origins = new Set<string>();
  for (const connector of project.connectors) {
    origins.add(new URL(connector.origin).origin);
    connector.allowedOrigins.forEach((origin) => origins.add(new URL(origin).origin));
  }
  project.pages.forEach((page) => {
    const origin = originOf(page.url);
    if (origin) origins.add(origin);
    if (page.offline?.kind === "html") {
      requestedOfflineOrigins(page.offline).forEach((item) => origins.add(item));
      page.offline.allowedNetworkOrigins?.forEach((item) => origins.add(item));
    }
  });
  const offline = project.pages.map((page) => page.offline).filter(Boolean);
  const embeddedBytes = offline.reduce((total, item) => total + (item?.kind === "html" ? (item.content?.length ?? 0) + (item.resources ?? []).reduce((sum, resource) => sum + Math.round(resource.dataUrl.length * 0.75), 0) : Math.round((item?.dataUrl?.length ?? 0) * 0.75)), 0);
  return {
    origins: [...origins].sort(),
    offlineHtmlPages: offline.filter((item) => item?.kind === "html").length,
    automatedConnectors: project.connectors.filter((connector) => connector.permission === "automate").length,
    highRiskSteps: project.pages.reduce((total, page) => total + page.script.steps.filter((step) => step.risk === "high").length, 0),
    embeddedBytes
  };
}

async function readTrustRecords(): Promise<Record<string, string>> {
  const records = await kvGet<Record<string, string>>(trustStorageKey);
  return records && typeof records === "object" ? records : {};
}

export async function trustProject(project: Project): Promise<void> {
  const records = await readTrustRecords();
  records[project.id] = await fingerprintProject(project);
  await kvSet(trustStorageKey, records);
}

export async function projectTrustState(project: Project): Promise<"untracked" | "trusted" | "changed"> {
  const trustedHash = (await readTrustRecords())[project.id];
  if (!trustedHash) return "untracked";
  return trustedHash === await fingerprintProject(project) ? "trusted" : "changed";
}

export async function forgetProjectTrust(projectId: string): Promise<void> {
  const records = await readTrustRecords();
  delete records[projectId];
  await kvSet(trustStorageKey, records);
}

export async function clearAllTrustForTests(): Promise<void> {
  await kvRemove(trustStorageKey);
}
