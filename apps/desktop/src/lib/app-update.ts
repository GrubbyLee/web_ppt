import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { recordDiagnostic } from "./diagnostics";
import { inTauri } from "./persistence";

export type DistributionInfo = {
  kind: "portable" | "appimage" | "linux-package" | "installer" | "unsupported";
  canInstallUpdate: boolean;
};

export type AppUpdateMetadata = {
  currentVersion: string;
  version: string;
  date?: string;
  notes?: string;
  releaseUrl?: string;
};

type UpdateStatus = "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "error" | "unavailable";

type AppUpdateState = {
  status: UpdateStatus;
  metadata: AppUpdateMetadata | null;
  distribution: DistributionInfo | null;
  progress: number | null;
  message: string | null;
  checkedAt: number | null;
  check: (manual?: boolean) => Promise<void>;
  install: () => Promise<void>;
  openDownload: () => Promise<void>;
};

let pendingUpdate: Update | null = null;
let checkPromise: Promise<void> | null = null;

function safeReleaseUrl(rawJson: Record<string, unknown>): string | undefined {
  for (const key of ["releaseUrl", "downloadUrl", "release_url", "download_url"]) {
    const value = rawJson[key];
    if (typeof value !== "string") continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:") return url.toString();
    } catch {
      // Ignore malformed release links from update metadata.
    }
  }
  return undefined;
}

function progressFromEvent(event: DownloadEvent, received: number, total: number | null): { received: number; total: number | null; progress: number | null; status: UpdateStatus } {
  if (event.event === "Started") {
    const nextTotal = event.data.contentLength ?? null;
    return { received: 0, total: nextTotal, progress: nextTotal ? 0 : null, status: "downloading" };
  }
  if (event.event === "Progress") {
    const nextReceived = received + event.data.chunkLength;
    return { received: nextReceived, total, progress: total ? Math.min(100, Math.round((nextReceived / total) * 100)) : null, status: "downloading" };
  }
  return { received, total, progress: 100, status: "installing" };
}

export const useAppUpdate = create<AppUpdateState>((set, get) => ({
  status: "idle",
  metadata: null,
  distribution: null,
  progress: null,
  message: null,
  checkedAt: null,
  check: async (manual = false) => {
    if (checkPromise) return checkPromise;
    checkPromise = (async () => {
      if (!inTauri()) {
        set({ status: "unavailable", message: manual ? "浏览器开发模式不检查桌面更新。" : null, checkedAt: Date.now() });
        return;
      }
      set({ status: "checking", message: null });
      try {
        const [{ check }, distribution, currentVersion] = await Promise.all([
          import("@tauri-apps/plugin-updater"),
          invoke<DistributionInfo>("distribution_info"),
          getVersion()
        ]);
        const update = await check({ timeout: 8_000 });
        pendingUpdate?.close().catch(() => undefined);
        pendingUpdate = update;
        if (!update) {
          set({ status: "current", metadata: null, distribution, progress: null, message: manual ? `当前已是最新稳定版（${currentVersion}）。` : null, checkedAt: Date.now() });
          return;
        }
        const releaseUrl = safeReleaseUrl(update.rawJson);
        set({
          status: "available",
          distribution,
          progress: null,
          message: null,
          checkedAt: Date.now(),
          metadata: {
            currentVersion: update.currentVersion,
            version: update.version,
            ...(update.date ? { date: update.date } : {}),
            ...(update.body ? { notes: update.body } : {}),
            ...(releaseUrl ? { releaseUrl } : {})
          }
        });
      } catch (error) {
        if (manual) recordDiagnostic("检查应用更新", error);
        set({ status: manual ? "error" : "unavailable", progress: null, message: manual ? "暂时无法连接稳定版更新服务。" : null, checkedAt: Date.now() });
      }
    })().finally(() => { checkPromise = null; });
    return checkPromise;
  },
  install: async () => {
    const { distribution } = get();
    if (!pendingUpdate || !distribution?.canInstallUpdate) return;
    let received = 0;
    let total: number | null = null;
    set({ status: "downloading", progress: 0, message: null });
    try {
      await pendingUpdate.downloadAndInstall((event) => {
        const next = progressFromEvent(event, received, total);
        received = next.received;
        total = next.total;
        set({ status: next.status, progress: next.progress });
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      const traceId = recordDiagnostic("安装应用更新", error);
      set({ status: "error", progress: null, message: `更新安装失败，诊断编号 ${traceId}` });
    }
  },
  openDownload: async () => {
    const url = get().metadata?.releaseUrl;
    if (!url) {
      set({ message: "更新服务未提供完整安装包下载地址。" });
      return;
    }
    try {
      await invoke("open_external_url", { url });
    } catch (error) {
      recordDiagnostic("打开更新下载页", error);
      set({ message: "无法打开完整安装包下载页。" });
    }
  }
}));
