import { CheckCircle2, DoorOpen, FolderOpen, MonitorUp, RefreshCw, Settings, ShieldCheck, ToggleLeft, ToggleRight } from "lucide-react";
import type { PresentationSession, Project } from "@showit/contracts";
import { ToolbarButton } from "../../components/ToolbarButton";
import { formatClock, formatDuration, plannedEndTime, screenModeLabel, timerStatusLabel } from "../../lib/format";

type PresenterTopBarProps = {
  project: Project;
  session: PresentationSession;
  now: number;
  onToggleAutoAdvance: () => void;
  onOpenProjects: () => void;
  onOpenSettings: () => void;
  onOpenAudience: () => void;
  onApplyProjectChanges: () => void;
  onEnd: () => void;
};

export function PresenterTopBar({
  project,
  session,
  now,
  onToggleAutoAdvance,
  onOpenProjects,
  onOpenSettings,
  onOpenAudience,
  onApplyProjectChanges,
  onEnd
}: PresenterTopBarProps) {
  const page = project.pages[session.currentPageIndex] ?? project.pages[0];

  return (
    <header className="presenter-top">
      <section className="presenter-brand" aria-label="项目信息">
        <strong>Showit</strong>
        <span>{project.name}</span>
      </section>
      <section className="signal-rail" aria-label="演示信号状态">
        <span data-state={session.audienceStatus}>观众屏 {session.audienceStatus === "synced" ? `${session.audienceCount} 人` : "未连接"}</span>
        <span>{timerStatusLabel(session.timerStatus)}</span>
        <span>{screenModeLabel(session.screenMode)}</span>
        <span>{page?.section ?? "未选择章节"}</span>
        <span>
          {session.currentPageIndex + 1}/{project.pages.length}
        </span>
      </section>
      <section className="presenter-meta" aria-label="时间与操作">
        <span>计划 {formatDuration(project.totalPlannedSeconds * 1_000)}</span>
        <span>预计 {formatClock(plannedEndTime(project, session, now))}</span>
        <ToolbarButton icon={<FolderOpen size={16} />} title="返回项目库" onClick={onOpenProjects} />
        <ToolbarButton
          icon={project.autoAdvanceEnabled ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
          label="自动翻页"
          title="切换自动翻页"
          active={project.autoAdvanceEnabled}
          onClick={onToggleAutoAdvance}
        />
        <ToolbarButton icon={<ShieldCheck size={16} />} label="演前检查" title="查看演前检查" onClick={onOpenSettings} />
        <ToolbarButton icon={<RefreshCw size={16} />} label="应用修改" title="将项目编辑器的最新修改应用到当前演示" onClick={onApplyProjectChanges} />
        <ToolbarButton icon={<Settings size={16} />} label="设置" title="打开设置" onClick={onOpenSettings} />
        <ToolbarButton icon={<MonitorUp size={16} />} label="观众屏" title="重新打开本机观众屏" onClick={onOpenAudience} />
        <ToolbarButton icon={<DoorOpen size={16} />} label="退出" title="退出演示" variant="danger" onClick={onEnd} />
        <CheckCircle2 className="top-ready-icon" size={16} aria-label="运行时就绪" />
      </section>
    </header>
  );
}
