import { ChevronsLeft, ChevronsRight, Pause, Play, RotateCcw, SkipBack, SkipForward, TimerReset } from "lucide-react";
import type { PresentationPage, PresentationSession, Project } from "@showit/contracts";
import { ToolbarButton } from "../../components/ToolbarButton";
import { elapsedMs, sectionElapsedMs } from "../../stores/presentation-store";
import { formatDuration, pageRemainingMs, projectProgress } from "../../lib/format";

type PresentationFooterProps = {
  project: Project;
  session: PresentationSession;
  page: PresentationPage;
  now: number;
  onFirst: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onLast: () => void;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  rehearsalActive: boolean;
  onRehearsal: () => void;
};

export function PresentationFooter({
  project,
  session,
  page,
  now,
  onFirst,
  onPrevious,
  onNext,
  onLast,
  onStart,
  onPause,
  onReset,
  rehearsalActive,
  onRehearsal
}: PresentationFooterProps) {
  const remaining = pageRemainingMs(session, page, now);
  const isRunning = session.timerStatus === "running";
  const progress = projectProgress(project, session);

  return (
    <footer className="presentation-footer" aria-label="演示计时和翻页">
      <section className="timer-cluster">
        <div>
          <span>总计时</span>
          <strong>{formatDuration(elapsedMs(session, true, now))}</strong>
        </div>
        <div>
          <span>本页计时</span>
          <strong>{formatDuration(elapsedMs(session, false, now))}</strong>
        </div>
        <div>
          <span>本章计时</span>
          <strong>{formatDuration(sectionElapsedMs(session, now))}</strong>
        </div>
        <div className={remaining < 0 ? "is-overrun" : ""}>
          <span>{remaining < 0 ? "超时" : "本页剩余"}</span>
          <strong>{formatDuration(Math.abs(remaining))}</strong>
        </div>
      </section>

      <nav className="page-controls" aria-label="页面翻页">
        <ToolbarButton icon={<ChevronsLeft size={17} />} title="首个页面" onClick={onFirst} />
        <ToolbarButton icon={<SkipBack size={17} />} title="上个页面" onClick={onPrevious} />
        <ToolbarButton icon={<SkipForward size={17} />} title="下个页面" onClick={onNext} />
        <ToolbarButton icon={<ChevronsRight size={17} />} title="最后页面" onClick={onLast} />
      </nav>

      <section className="session-controls">
        <ToolbarButton
          icon={isRunning ? <Pause size={17} /> : <Play size={17} />}
          label={isRunning ? "暂停" : session.timerStatus === "paused" ? "继续" : "开始"}
          title={isRunning ? "暂停计时" : "开始或继续计时"}
          variant="primary"
          onClick={isRunning ? onPause : onStart}
        />
        <ToolbarButton icon={<RotateCcw size={17} />} label="重置" title="重置计时" onClick={onReset} />
        <ToolbarButton
          icon={<TimerReset size={17} />}
          label={rehearsalActive ? "结束排练" : "排练"}
          title={rehearsalActive ? "结束并保存排练记录" : "从第一页开始排练"}
          active={rehearsalActive}
          onClick={onRehearsal}
        />
        <div className="footer-progress">
          <strong>{progress}%</strong>
          <span>
            {session.currentPageIndex + 1}/{project.pages.length}
          </span>
        </div>
      </section>
    </footer>
  );
}
