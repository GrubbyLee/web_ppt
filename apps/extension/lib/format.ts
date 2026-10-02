import type { PresentationPage, PresentationSession, Project } from "@showit/contracts";
import { elapsedMs } from "../session/machine";

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(timestamp);
}

export function pageRemainingMs(session: PresentationSession, page: PresentationPage, now = Date.now()): number {
  return page.estimatedSeconds * 1_000 - elapsedMs(session, false, now);
}

export function projectProgress(project: Project, session: PresentationSession): number {
  if (project.pages.length === 0) return 0;
  return Math.round(((session.currentPageIndex + 1) / project.pages.length) * 100);
}

export function plannedEndTime(project: Project, session: PresentationSession, now = Date.now()): number {
  const elapsed = elapsedMs(session, true, now);
  const remaining = Math.max(0, project.totalPlannedSeconds * 1_000 - elapsed);
  return now + remaining;
}

export function screenModeLabel(mode: PresentationSession["screenMode"]): string {
  const labels: Record<PresentationSession["screenMode"], string> = {
    normal: "正常",
    black: "黑屏",
    white: "白屏",
    frozen: "冻结",
    privacy: "隐私遮挡",
    mask: "遮挡中",
    ended: "结束"
  };
  return labels[mode] ?? mode;
}

export function timerStatusLabel(status: PresentationSession["timerStatus"]): string {
  const labels: Record<PresentationSession["timerStatus"], string> = {
    idle: "未开始",
    running: "计时中",
    paused: "已暂停"
  };
  return labels[status] ?? status;
}
