import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import type { PresentationSession, PresentationStep, SensitiveRuntimeVariable } from "@showit/contracts";
import type { BgMessage, BroadcastState, RemoteAudienceState, UiMessage } from "@/messaging/protocol";
import { PORT_PREFIX } from "@/messaging/protocol";
import type { SessionAction } from "@/session/machine";
import { elapsedMs, sectionElapsedMs, autoAdvanceElapsedMs } from "@/session/machine";
import { ToolbarButton } from "@/components/ToolbarButton";
import { MarkdownView } from "@/components/MarkdownView";
import { formatDuration, pageRemainingMs, projectProgress, screenModeLabel, timerStatusLabel } from "@/lib/format";
import { resolveTemplate } from "@/lib/template";
import { runProjectPreflight } from "@/lib/preflight";
import { downloadMarkdownScript } from "@/lib/export";
import { downloadDiagnostics, listDiagnostics } from "@/lib/diagnostics";
import {
  CircleDot,
  Eraser,
  FileText,
  FlaskConical,
  Keyboard,
  MonitorPlay,
  Moon,
  Pause,
  Play,
  Power,
  RotateCcw,
  Settings,
  Square,
  Sun,
  Timer,
  TriangleAlert
} from "lucide-react";

type DialogKind = "high-risk" | "force-complete" | "secrets" | "offline-origin" | "rehearsal-note" | "relay" | "settings" | "shortcuts" | null;

export function App() {
  const [state, setState] = useState<BroadcastState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [notesEditing, setNotesEditing] = useState(false);
  const [notesDraft, setNotesDraft] = useState<string | null>(null);
  const [forceReason, setForceReason] = useState("");
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [rehearsalNote, setRehearsalNote] = useState("");
  const [health, setHealth] = useState<Array<{ pageId: string; ok: boolean; status: number | null; error: string | null; elapsedMs: number }>>([]);
  const [healthBusy, setHealthBusy] = useState(false);
  const [diagnosticEntries, setDiagnosticEntries] = useState<Array<{ traceId: string; at: number; area: string; message: string }>>([]);
  const [relayBase, setRelayBase] = useState("");
  const [relayCopied, setRelayCopied] = useState(false);
  const portRef = useRef<Browser.runtime.Port | null>(null);
  const notesEditingRef = useRef(false);
  notesEditingRef.current = notesEditing || dialog !== null;

  const send = useCallback((message: UiMessage) => {
    try {
      portRef.current?.postMessage(message);
    } catch {
      // Reconnect happens below on the next tick.
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const connect = () => {
      if (stopped) return;
      let port: Browser.runtime.Port;
      try {
        port = browser.runtime.connect({ name: `${PORT_PREFIX}sidepanel` });
      } catch {
        scheduleReconnect();
        return;
      }
      portRef.current = port;
      port.onMessage.addListener((message: BgMessage) => {
        if (message.type === "state") setState(message.state);
      });
      port.onDisconnect.addListener(() => {
        if (portRef.current === port) portRef.current = null;
        scheduleReconnect();
      });
      attempt = 0;
      try {
        port.postMessage({ type: "hello", ctx: "sidepanel" } satisfies UiMessage);
      } catch {
        scheduleReconnect();
      }
    };
    const scheduleReconnect = () => {
      if (stopped || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, Math.min(10_000, 500 * 2 ** Math.min(attempt++, 5)));
    };
    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        portRef.current?.disconnect();
      } catch {
        // Already disconnected.
      }
    };
  }, []);

  useEffect(() => {
    void browser.storage.local.get("showit:relay-base:v1").then((stored) => {
      const value = (stored as Record<string, unknown>)["showit:relay-base:v1"];
      if (typeof value === "string" && value.trim()) setRelayBase(value.trim());
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      send({ type: "tick", uiBlocked: notesEditingRef.current });
    }, 500);
    return () => clearInterval(timer);
  }, [send]);

  const machine = state?.machine ?? null;
  const meta = state?.meta;
  const missingSecretKeys = meta?.missingSecrets ?? [];
  const page = machine ? machine.project.pages[machine.session.currentPageIndex] ?? null : null;
  const session = machine?.session ?? null;
  const project = machine?.project ?? null;

  const act = useCallback((action: SessionAction) => send({ type: "action", action }), [send]);

  useEffect(() => {
    if (session?.pendingHighRiskStepId && dialog === null) setDialog("high-risk");
    if (!session?.pendingHighRiskStepId && dialog === "high-risk") setDialog(null);
  }, [session?.pendingHighRiskStepId, dialog]);

  useEffect(() => {
    if (meta?.stepExecution?.state === "failed" && dialog === null) {
      setForceReason("");
      setDialog("force-complete");
    }
    if (meta?.stepExecution?.state !== "failed" && dialog === "force-complete") setDialog(null);
  }, [meta?.stepExecution, dialog]);

  useEffect(() => {
    if ((missingSecretKeys.length) > 0 && dialog === null) {
      setSecretValues({});
      setDialog("secrets");
    }
    if (missingSecretKeys.length === 0 && dialog === "secrets") setDialog(null);
  }, [missingSecretKeys, dialog]);

  useEffect(() => {
    if (meta?.offlineOriginRequest && dialog === null) setDialog("offline-origin");
    if (!meta?.offlineOriginRequest && dialog === "offline-origin") setDialog(null);
  }, [meta?.offlineOriginRequest, dialog]);

  // Keyboard shortcuts (panel must be focused).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!machine || !session) return;
      if (event.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
      const dialogOpen = dialog !== null;
      switch (event.key) {
        case "Escape":
          if (dialogOpen) setDialog(null);
          else if (notesEditing) setNotesEditing(false);
          else if (session.annotationTool !== "none") act({ type: "set-annotation-tool", tool: "none" });
          else if (session.screenMode !== "normal") act({ type: "set-screen-mode", screenMode: "normal" });
          return;
        case "ArrowRight":
          if (!dialogOpen) act({ type: "set-active-page", index: session.currentPageIndex + 1 });
          return;
        case "ArrowLeft":
          if (!dialogOpen) act({ type: "set-active-page", index: session.currentPageIndex - 1 });
          return;
        case "ArrowDown":
          if (!dialogOpen) act({ type: "next-step" });
          return;
        case "ArrowUp":
          if (!dialogOpen) act({ type: "previous-step" });
          return;
        case " ":
          if (!dialogOpen) {
            event.preventDefault();
            act({ type: session.timerStatus === "running" ? "pause-timer" : "start-timer" });
          }
          return;
        default:
          break;
      }
      if (dialogOpen || event.ctrlKey || event.metaKey || event.altKey) return;
      switch (event.key.toLowerCase()) {
        case "l":
          act({ type: "set-annotation-tool", tool: session.annotationTool === "laser" ? "none" : "laser" });
          return;
        case "c":
          act({ type: "set-annotation-tool", tool: session.annotationTool === "circle" ? "none" : "circle" });
          return;
        case "b":
          act({ type: "set-screen-mode", screenMode: session.screenMode === "black" ? "normal" : "black" });
          return;
        case "w":
          act({ type: "set-screen-mode", screenMode: session.screenMode === "white" ? "normal" : "white" });
          return;
        case "f":
          act({ type: "set-screen-mode", screenMode: session.screenMode === "frozen" ? "normal" : "frozen" });
          return;
        case "p":
          act({ type: "set-screen-mode", screenMode: session.screenMode === "privacy" ? "normal" : "privacy" });
          return;
        case "a":
          act({ type: "set-auto-advance", enabled: !project?.autoAdvanceEnabled });
          return;
        case "r":
          if (machine.rehearsalStartedAt === null) act({ type: "start-rehearsal" });
          else {
            setRehearsalNote("");
            setDialog("rehearsal-note");
          }
          return;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [act, dialog, machine, notesEditing, project?.autoAdvanceEnabled, session]);

  const preflight = useMemo(() => (dialog === "settings" && project ? runProjectPreflight(project) : null), [dialog, project]);

  const runHealthCheck = useCallback(async () => {
    if (!project) return;
    setHealthBusy(true);
    const results: typeof health = [];
    for (const pageItem of project.pages) {
      if (!pageItem.url) continue;
      const resolved = resolveTemplate(pageItem.url, project, pageItem, "url");
      if (!resolved.ok) continue;
      const started = performance.now();
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(resolved.value, { method: "GET", credentials: "omit", cache: "no-store", signal: controller.signal });
        clearTimeout(timeout);
        results.push({ pageId: pageItem.id, ok: response.ok, status: response.status, error: null, elapsedMs: Math.round(performance.now() - started) });
      } catch (error) {
        results.push({ pageId: pageItem.id, ok: false, status: null, error: error instanceof DOMException && error.name === "AbortError" ? "加载超时" : "无法访问（可能缺少站点授权）", elapsedMs: Math.round(performance.now() - started) });
      }
    }
    setHealth(results);
    setHealthBusy(false);
  }, [project]);

  useEffect(() => {
    if (dialog === "settings") void listDiagnostics().then(setDiagnosticEntries);
  }, [dialog]);

  // ---- landing -----------------------------------------------------------------

  if (!machine || !session || !project || !page || !meta) {
    return (
      <main className="panel panel--landing">
        <header className="panel-brand"><strong>Showit</strong><span>演讲者控制台</span></header>
        <section className="landing">
          <p>{machine ? (meta?.live ? "正在同步演示会话…" : "演示会话已恢复，但画面标签未连接。") : "当前没有正在运行的演示。"}</p>
          {machine && !meta?.live ? <ToolbarButton icon={<Play size={16} />} label="恢复画面标签" variant="primary" onClick={() => send({ type: "resume" })} /> : null}
          <ToolbarButton icon={<FileText size={16} />} label="打开工作台" onClick={() => send({ type: "open-workbench" })} />
          <ToolbarButton icon={<Keyboard size={16} />} label="快捷键" onClick={() => setDialog("shortcuts")} />
        </section>
        {machine ? <SessionSummary session={machine.session} now={now} /> : null}
        <ShortcutsDialog open={dialog === "shortcuts"} onClose={() => setDialog(null)} />
      </main>
    );
  }

  const steps = page.script.steps;
  const offlineActive = session.offlineFallbackPageId === page.id;
  const connectorChip = meta.connectorState
    ? meta.connectorState.state === "ready" ? { text: "业务页就绪", tone: "ok" as const }
      : meta.connectorState.state === "anonymous" ? { text: "未登录", tone: "warn" as const }
        : meta.connectorState.state === "role-mismatch" ? { text: `角色不符${meta.connectorState.role ? `：${meta.connectorState.role}` : ""}`, tone: "warn" as const }
          : { text: meta.connectorState.reason ?? "业务页受阻", tone: "bad" as const }
    : null;
  const total = elapsedMs(session, true, now);
  const pageElapsed = elapsedMs(session, false, now);
  const sectionElapsed = sectionElapsedMs(session, now);
  const remaining = pageRemainingMs(session, page, now);
  const autoAdvanceMs = autoAdvanceElapsedMs(session, now);
  const thresholdSeconds = page.autoAdvanceSeconds ?? project.autoAdvanceSeconds;
  const autoAdvanceRatio = project.autoAdvanceEnabled ? Math.min(1, autoAdvanceMs / (thresholdSeconds * 1000)) : 0;
  const stepExecution = meta.stepExecution;

  return (
    <main className="panel">
      <header className="panel-brand">
        <strong>Showit</strong>
        <span className="panel-brand__project">{project.name}</span>
        <span className="chip chip--muted">{timerStatusLabel(session.timerStatus)}</span>
        {session.screenMode !== "normal" ? <span className="chip chip--warn">{screenModeLabel(session.screenMode)}</span> : null}
        <span className="chip chip--muted">{meta.viewerCount > 0 || machine.localAudience ? `观众 ${meta.viewerCount}` : "无观众"}</span>
      </header>

      <section className="panel-page" aria-label="当前页面">
        <div className="panel-page__head">
          <span className="panel-page__index">{session.currentPageIndex + 1}/{project.pages.length}</span>
          <div>
            <strong>{page.title}</strong>
            <small>{page.section}{page.role ? ` · ${page.role}` : ""}</small>
          </div>
        </div>
        {page.purpose ? <p className="panel-page__purpose">{page.purpose}</p> : null}
        <div className="panel-page__chips">
          {connectorChip ? <span className={`chip chip--${connectorChip.tone}`}>{connectorChip.text}</span> : <span className="chip chip--muted">画面{meta.live ? "已连接" : "未连接"}</span>}
          {offlineActive ? <span className="chip chip--warn">{project.brand.offlineLabel}</span> : null}
          {meta.businessReady ? null : <span className="chip chip--warn">画面未就绪</span>}
        </div>
        <div className="panel-page__tools" role="toolbar" aria-label="页面工具">
          <ToolbarButton icon={<CircleDot size={15} />} title="激光笔（L）" active={session.annotationTool === "laser"} onClick={() => act({ type: "set-annotation-tool", tool: session.annotationTool === "laser" ? "none" : "laser" })} />
          <ToolbarButton icon={<FlaskConical size={15} />} title="圈选标注（C）" active={session.annotationTool === "circle"} onClick={() => act({ type: "set-annotation-tool", tool: session.annotationTool === "circle" ? "none" : "circle" })} />
          <ToolbarButton icon={<Square size={15} />} title="清除本页标注" onClick={() => act({ type: "clear-annotations" })} />
          <ToolbarButton icon={<Eraser size={15} />} title="框选隐私遮罩元素" onClick={() => send({ type: "pick-mask" })} />
          <ToolbarButton icon={<TriangleAlert size={15} />} title={offlineActive ? "返回业务页面" : "切换离线备用"} active={offlineActive} disabled={!page.offline && !offlineActive} onClick={() => act({ type: "set-offline-fallback-active", active: !offlineActive })} />
        </div>
      </section>

      <section className="panel-steps" aria-label="步骤与讲稿">
        <div className="panel-steps__list">
          {steps.map((step, index) => {
            const completed = session.completedStepIds.includes(step.id);
            const executing = stepExecution?.stepId === step.id;
            return (
              <button
                key={step.id}
                type="button"
                className={`panel-step${completed ? " is-done" : ""}${executing ? " is-executing" : ""}`}
                onClick={() => send({ type: "execute-step", stepId: step.id })}
                aria-current={executing ? "step" : undefined}
              >
                <span className="panel-step__index">{index + 1}</span>
                <span className="panel-step__body">
                  <strong>{step.text}</strong>
                  <small>
                    {step.risk === "high" ? "高风险 · " : ""}{kindLabel(step)}
                    {step.recordedAction ? " · 可执行" : ""}
                    {executing ? (stepExecution?.state === "failed" ? ` · 失败：${stepExecution.reason ?? ""}` : stepExecution?.state === "manual" ? " · 等待人工确认" : " · 执行中") : ""}
                  </small>
                </span>
                <span className={`panel-step__mark${completed ? " is-done" : ""}`} aria-hidden="true" />
              </button>
            );
          })}
        </div>
        <div className="panel-steps__nav">
          <ToolbarButton icon={<Play size={14} />} label="下一步骤" onClick={() => act({ type: "next-step" })} />
          <ToolbarButton icon={<Pause size={14} />} label="上一步骤" onClick={() => act({ type: "previous-step" })} />
          {stepExecution?.state === "manual" ? <ToolbarButton icon={<Play size={14} />} label="确认完成" variant="primary" onClick={() => act({ type: "complete-step", stepId: stepExecution.stepId })} /> : null}
        </div>

        <div className="panel-notes">
          <div className="panel-notes__head">
            <span>讲稿</span>
            <div>
              <ToolbarButton icon={<FileText size={13} />} title={notesEditing ? "预览讲稿" : "编辑讲稿"} active={notesEditing} onClick={() => {
                if (notesEditing && notesDraft !== null) act({ type: "update-script", markdown: notesDraft });
                setNotesEditing(!notesEditing);
                setNotesDraft(null);
              }} />
              <ToolbarButton icon={<FileText size={13} />} title="导出本页讲稿" onClick={() => downloadMarkdownScript(project, page.id)} />
              <ToolbarButton icon="A+" title="放大讲稿字号" onClick={() => act({ type: "set-note-font-scale", fontScale: project.layout.noteFontScale + 0.05 })} />
              <ToolbarButton icon="A-" title="缩小讲稿字号" onClick={() => act({ type: "set-note-font-scale", fontScale: project.layout.noteFontScale - 0.05 })} />
            </div>
          </div>
          {notesEditing ? (
            <textarea
              className="panel-notes__editor"
              value={notesDraft ?? page.script.markdown}
              onChange={(event) => setNotesDraft(event.target.value)}
              onBlur={() => {
                if (notesDraft !== null) act({ type: "update-script", markdown: notesDraft });
              }}
              aria-label="讲稿编辑"
            />
          ) : (
            <div className="panel-notes__view" style={{ fontSize: `${project.layout.noteFontScale * 100}%` }}>
              <MarkdownView markdown={page.script.markdown} />
            </div>
          )}
        </div>
      </section>

      {meta.message ? <output className="panel-message">{meta.message}</output> : null}

      <footer className="panel-footer">
        <div className="panel-timers">
          <div><span>总计时</span><strong>{formatDuration(total)}</strong></div>
          <div><span>本页</span><strong>{formatDuration(pageElapsed)}</strong></div>
          <div><span>本章</span><strong>{formatDuration(sectionElapsed)}</strong></div>
          <div className={remaining < 0 ? "is-over" : ""}><span>剩余</span><strong>{formatDuration(Math.abs(remaining))}{remaining < 0 ? "+" : ""}</strong></div>
        </div>
        {project.autoAdvanceEnabled ? <progress className="panel-autoadvance" max={1} value={autoAdvanceRatio} aria-label="自动翻页进度" /> : null}
        <div className="panel-footer__nav">
          <ToolbarButton icon="⏮" title="首页" onClick={() => act({ type: "set-active-page", index: 0 })} />
          <ToolbarButton icon="◀" title="上一页" onClick={() => act({ type: "set-active-page", index: session.currentPageIndex - 1 })} />
          <ToolbarButton icon="▶" title="下一页" onClick={() => act({ type: "set-active-page", index: session.currentPageIndex + 1 })} />
          <ToolbarButton icon="⏭" title="末页" onClick={() => act({ type: "set-active-page", index: project.pages.length - 1 })} />
          {session.timerStatus === "running"
            ? <ToolbarButton icon={<Pause size={14} />} label="暂停" onClick={() => act({ type: "pause-timer" })} />
            : <ToolbarButton icon={<Play size={14} />} label="计时" onClick={() => act({ type: "start-timer" })} />}
          <ToolbarButton icon={<RotateCcw size={14} />} title="重置计时" onClick={() => act({ type: "reset-timer" })} />
          <ToolbarButton icon={<Timer size={14} />} label={machine.rehearsalStartedAt !== null ? "结束排练" : "排练"} active={machine.rehearsalStartedAt !== null} onClick={() => {
            if (machine.rehearsalStartedAt === null) act({ type: "start-rehearsal" });
            else {
              setRehearsalNote("");
              setDialog("rehearsal-note");
            }
          }} />
          <ToolbarButton icon="A" title={project.autoAdvanceEnabled ? "关闭自动翻页" : "开启自动翻页"} active={project.autoAdvanceEnabled} onClick={() => act({ type: "set-auto-advance", enabled: !project.autoAdvanceEnabled })} />
        </div>
        <div className="panel-footer__modes">
          <ToolbarButton icon={<Moon size={14} />} title="黑屏（B）" active={session.screenMode === "black"} onClick={() => act({ type: "set-screen-mode", screenMode: session.screenMode === "black" ? "normal" : "black" })} />
          <ToolbarButton icon={<Sun size={14} />} title="白屏（W）" active={session.screenMode === "white"} onClick={() => act({ type: "set-screen-mode", screenMode: session.screenMode === "white" ? "normal" : "white" })} />
          <ToolbarButton icon="❄" title="冻结画面（F）" active={session.screenMode === "frozen"} onClick={() => act({ type: "set-screen-mode", screenMode: session.screenMode === "frozen" ? "normal" : "frozen" })} />
          <ToolbarButton icon={<TriangleAlert size={14} />} title="隐私遮挡（P）" active={session.screenMode === "privacy"} onClick={() => act({ type: "set-screen-mode", screenMode: session.screenMode === "privacy" ? "normal" : "privacy" })} />
          <ToolbarButton icon={<MonitorPlay size={14} />} label="共享画面" title="打开只读共享画面窗口：用于视频会议共享，或接第二显示器预览（观众不看本机）" onClick={() => send({ type: "open-audience" })} />
          <ToolbarButton
            icon="🌐"
            label={meta.remote ? `远程 ${meta.remote.viewerCount}` : "远程观众"}
            title={meta.remote ? "管理远程观众（链接/批准/结束）" : "通过中继开启局域网/公网观众"}
            active={Boolean(meta.remote)}
            onClick={() => {
              if (meta.remote) {
                setDialog("relay");
                return;
              }
              if (!relayBase.trim()) {
                setDialog("relay");
                return;
              }
              send({ type: "open-remote-audience", relayBase: relayBase.trim() });
            }}
          />
          {meta.viewerCount >= 0 && machine.localAudience && !meta.captureActive ? <ToolbarButton icon={<MonitorPlay size={14} />} label="授权画面捕获" title="捕获需要页面手势授权（右键菜单或 Ctrl+Shift+9）；此按钮在授权后重试" onClick={() => send({ type: "authorize-capture" })} /> : null}
          <ToolbarButton icon={<Settings size={14} />} title="设置" onClick={() => setDialog("settings")} />
          <ToolbarButton icon={<Power size={14} />} label="结束" variant="danger" onClick={() => send({ type: "end-session" })} />
        </div>
        <div className="panel-footer__progress"><span>{projectProgress(project, session)}%</span><progress max={100} value={projectProgress(project, session)} /></div>
      </footer>

      {dialog === "high-risk" && session.pendingHighRiskStepId ? (
        <HighRiskDialog
          step={steps.find((step) => step.id === session.pendingHighRiskStepId) ?? null}
          executing={stepExecution?.stepId === session.pendingHighRiskStepId}
          onConfirm={() => act({ type: "confirm-high-risk-step" })}
          onConfirmExecute={() => send({ type: "execute-step", stepId: session.pendingHighRiskStepId!, confirmed: true })}
          onCancel={() => act({ type: "cancel-high-risk-step" })}
        />
      ) : null}

      {dialog === "force-complete" && stepExecution ? (
        <ForceCompleteDialog
          step={steps.find((step) => step.id === stepExecution.stepId) ?? null}
          reason={stepExecution.reason}
          value={forceReason}
          onChange={setForceReason}
          onForce={() => {
            act({ type: "force-complete-step", stepId: stepExecution.stepId, reason: forceReason });
            setDialog(null);
          }}
          onRetry={() => {
            send({ type: "execute-step", stepId: stepExecution.stepId });
            setDialog(null);
          }}
        />
      ) : null}

      {dialog === "secrets" ? (
        <SecretsDialog
          variables={project.sensitiveVariables.filter((variable) => missingSecretKeys.includes(variable.key))}
          values={secretValues}
          onChange={setSecretValues}
          onSubmit={() => {
            send({ type: "secrets", values: secretValues });
            setDialog(null);
          }}
        />
      ) : null}

      {dialog === "offline-origin" && meta.offlineOriginRequest ? (
        <OfflineOriginDialog
          origin={meta.offlineOriginRequest}
          onGrant={() => {
            act({ type: "grant-offline-network-origin", origin: meta.offlineOriginRequest! });
            setDialog(null);
          }}
          onDeny={() => setDialog(null)}
        />
      ) : null}

      {dialog === "rehearsal-note" ? (
        <RehearsalNoteDialog
          value={rehearsalNote}
          onChange={setRehearsalNote}
          onFinish={() => {
            act({ type: "finish-rehearsal", note: rehearsalNote });
            setDialog(null);
          }}
        />
      ) : null}

      {dialog === "relay" ? (
        <RelayDialog
          value={relayBase}
          onChange={setRelayBase}
          remote={meta.remote}
          copied={relayCopied}
          onCopied={() => setRelayCopied(true)}
          onOpen={async () => {
            if (!relayBase.trim()) return;
            const base = relayBase.trim();
            try {
              await browser.permissions.request({ origins: [`${new URL(base).origin}/*`] });
            } catch {
              /* Non-loopback origins need the grant; localhost is already in host_permissions. */
            }
            void browser.storage.local.set({ "showit:relay-base:v1": base });
            send({ type: "open-remote-audience", relayBase: base });
            setDialog(null);
          }}
          onEnd={() => {
            send({ type: "end-remote-audience" });
            setDialog(null);
          }}
          onCopy={() => {
            void navigator.clipboard.writeText(meta.remote?.viewerLink ?? "").then(() => setRelayCopied(true));
          }}
          onApprove={(viewerId) => send({ type: "relay-decide-viewer", viewerId, approve: true })}
          onReject={(viewerId) => send({ type: "relay-decide-viewer", viewerId, approve: false })}
          onKick={(viewerId) => send({ type: "relay-kick-viewer", viewerId })}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog === "settings" ? (
        <SettingsDrawer
          project={project}
          currentPage={page}
          preflight={preflight}
          health={health}
          healthBusy={healthBusy}
          diagnostics={diagnosticEntries}
          onAutoAdvanceSeconds={(seconds) => act({ type: "set-auto-advance-seconds", seconds })}
          onPageAutoAdvanceSeconds={(seconds) => act({ type: "set-current-page-auto-advance-seconds", seconds })}
          onRunHealthCheck={() => void runHealthCheck()}
          onDownloadDiagnostics={() => void downloadDiagnostics()}
          onClose={() => setDialog(null)}
        />
      ) : null}

      <ShortcutsDialog open={dialog === "shortcuts"} onClose={() => setDialog(null)} />
    </main>
  );
}

function kindLabel(step: PresentationStep): string {
  const labels: Record<PresentationStep["kind"], string> = { say: "讲述", act: "操作", expect: "预期", transition: "转场" };
  return labels[step.kind];
}

function SessionSummary({ session, now }: { session: PresentationSession; now: number }) {
  return (
    <section className="landing__summary">
      <div><span>总计时</span><strong>{formatDuration(elapsedMs(session, true, now))}</strong></div>
      <div><span>页码</span><strong>{session.currentPageIndex + 1}</strong></div>
      <div><span>状态</span><strong>{screenModeLabel(session.screenMode)}</strong></div>
    </section>
  );
}

function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose?: () => void }) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
        {onClose ? (
          <div className="dialog__actions">
            <ToolbarButton icon="✕" label="关闭" onClick={onClose} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function HighRiskDialog({ step, executing, onConfirm, onConfirmExecute, onCancel }: { step: PresentationStep | null; executing: boolean; onConfirm: () => void; onConfirmExecute: () => void; onCancel: () => void }) {
  return (
    <Dialog title="高风险步骤确认">
      <p>{step ? step.text : "未知步骤"} — 该步骤被标记为高风险，需要显式确认后才能完成。</p>
      <div className="dialog__actions">
        <ToolbarButton icon="✕" label="取消" onClick={onCancel} />
        <ToolbarButton icon={<Play size={14} />} label="确认并执行" disabled={executing || !step?.recordedAction} onClick={onConfirmExecute} />
        <ToolbarButton icon={<Play size={14} />} label="确认完成" variant="primary" disabled={executing} onClick={onConfirm} />
      </div>
    </Dialog>
  );
}

function ForceCompleteDialog({ step, reason, value, onChange, onForce, onRetry }: { step: PresentationStep | null; reason?: string | undefined; value: string; onChange: (value: string) => void; onForce: () => void; onRetry: () => void }) {
  return (
    <Dialog title="步骤执行失败">
      <p>{step ? step.text : "未知步骤"} — {reason ?? "动作执行失败"}。可以填写原因强制完成，或重新执行。</p>
      <label className="field">
        <span>强制完成原因（必填）</span>
        <textarea rows={3} value={value} maxLength={500} onChange={(event) => onChange(event.target.value)} />
      </label>
      <div className="dialog__actions">
        <ToolbarButton icon={<RotateCcw size={14} />} label="重新执行" onClick={onRetry} />
        <ToolbarButton icon={<Play size={14} />} label="强制完成" variant="primary" disabled={!value.trim()} onClick={onForce} />
      </div>
    </Dialog>
  );
}

function SecretsDialog({ variables, values, onChange, onSubmit }: { variables: SensitiveRuntimeVariable[]; values: Record<string, string>; onChange: (values: Record<string, string>) => void; onSubmit: () => void }) {
  return (
    <Dialog title="输入敏感变量">
      <p>以下敏感值仅保存在浏览器内存中，浏览器关闭后即清除，不会写入项目或磁盘。</p>
      {variables.map((variable) => (
        <label className="field" key={variable.key}>
          <span>{variable.label}（{variable.key}，{variable.expiresAfterMinutes} 分钟后过期）</span>
          <input type="password" autoComplete="off" value={values[variable.key] ?? ""} onChange={(event) => onChange({ ...values, [variable.key]: event.target.value })} />
        </label>
      ))}
      <div className="dialog__actions">
        <ToolbarButton icon={<Play size={14} />} label="提交并继续" variant="primary" disabled={variables.some((variable) => variable.required && !(values[variable.key] ?? "").trim())} onClick={onSubmit} />
      </div>
    </Dialog>
  );
}

function OfflineOriginDialog({ origin, onGrant, onDeny }: { origin: string; onGrant: () => void; onDeny: () => void }) {
  return (
    <Dialog title="离线内容请求网络访问">
      <p>隔离的离线 HTML 内容请求访问 <strong>{origin}</strong>。仅本次演示运行内允许；拒绝后内容保持离线。</p>
      <div className="dialog__actions">
        <ToolbarButton icon="✕" label="拒绝" onClick={onDeny} />
        <ToolbarButton icon={<Play size={14} />} label="本次允许" variant="primary" onClick={onGrant} />
      </div>
    </Dialog>
  );
}

function RehearsalNoteDialog({ value, onChange, onFinish }: { value: string; onChange: (value: string) => void; onFinish: () => void }) {
  return (
    <Dialog title="结束排练">
      <label className="field">
        <span>排练备注（可选）</span>
        <textarea rows={3} value={value} maxLength={2000} onChange={(event) => onChange(event.target.value)} />
      </label>
      <div className="dialog__actions">
        <ToolbarButton icon={<Play size={14} />} label="保存排练记录" variant="primary" onClick={onFinish} />
      </div>
    </Dialog>
  );
}

function SettingsDrawer({ project, currentPage, preflight, health, healthBusy, diagnostics, onAutoAdvanceSeconds, onPageAutoAdvanceSeconds, onRunHealthCheck, onDownloadDiagnostics, onClose }: {
  project: Parameters<typeof runProjectPreflight>[0];
  currentPage: Parameters<typeof runProjectPreflight>[0]["pages"][number];
  preflight: ReturnType<typeof runProjectPreflight> | null;
  health: Array<{ pageId: string; ok: boolean; status: number | null; error: string | null; elapsedMs: number }>;
  healthBusy: boolean;
  diagnostics: Array<{ traceId: string; at: number; area: string; message: string }>;
  onAutoAdvanceSeconds: (seconds: number) => void;
  onPageAutoAdvanceSeconds: (seconds: number | undefined) => void;
  onRunHealthCheck: () => void;
  onDownloadDiagnostics: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog title="演示设置" onClose={onClose}>
      <label className="field">
        <span>全局自动翻页间隔（秒）</span>
        <input type="number" min={1} max={14400} value={project.autoAdvanceSeconds} onChange={(event) => onAutoAdvanceSeconds(Math.max(1, Number(event.target.value) || 1))} />
      </label>
      <label className="field">
        <span>本页（{currentPage.title}）自动翻页间隔（秒，留空继承全局）</span>
        <input type="number" min={1} max={14400} value={currentPage.autoAdvanceSeconds ?? ""} placeholder="继承全局" onChange={(event) => onPageAutoAdvanceSeconds(event.target.value ? Math.max(1, Number(event.target.value)) : undefined)} />
      </label>
      {preflight ? (
        <section className="panel-settings__preflight" aria-label="发布前检查">
          <h3>发布前检查</h3>
          {preflight.items.slice(0, 10).map((item) => <p key={item.id} data-state={item.state}>{item.message}</p>)}
          {preflight.items.length > 10 ? <p>另有 {preflight.items.length - 10} 项。</p> : null}
        </section>
      ) : null}
      <div className="dialog__actions">
        <ToolbarButton icon={<Play size={14} />} label={healthBusy ? "检查中…" : "逐页健康检查"} disabled={healthBusy} onClick={onRunHealthCheck} />
        <ToolbarButton icon={<FileText size={14} />} label="下载诊断" onClick={onDownloadDiagnostics} />
      </div>
      {health.length > 0 ? (
        <section className="panel-settings__health" aria-label="健康检查结果">
          {health.map((item) => {
            const healthPage = project.pages.find((candidate) => candidate.id === item.pageId);
            return <p key={item.pageId} data-state={item.ok ? "ok" : "bad"}>{healthPage?.title ?? item.pageId}：{item.ok ? `正常（${item.status}，${item.elapsedMs}ms）` : `${item.error ?? "异常"}${item.status ? `（${item.status}）` : ""}`}</p>;
          })}
        </section>
      ) : null}
      {diagnostics.length > 0 ? (
        <section className="panel-settings__diagnostics" aria-label="运行诊断">
          <h3>运行诊断（已脱敏）</h3>
          {diagnostics.slice(0, 5).map((entry) => <p key={entry.traceId}><small>{new Date(entry.at).toLocaleTimeString("zh-CN")} · {entry.area}</small> {entry.message}</p>)}
        </section>
      ) : null}
    </Dialog>
  );
}

function RelayDialog({ value, onChange, remote, copied, onCopied, onOpen, onEnd, onCopy, onApprove, onReject, onKick, onClose }: {
  value: string;
  onChange: (value: string) => void;
  remote: RemoteAudienceState | null;
  copied: boolean;
  onCopied: () => void;
  onOpen: () => void;
  onEnd: () => void;
  onCopy: () => void;
  onApprove: (viewerId: string) => void;
  onReject: (viewerId: string) => void;
  onKick: (viewerId: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog title="远程观众（局域网 / 公网）" onClose={onClose}>
      {remote ? (
        <>
          <p>房间已开启。把下面的链接发给观众（也可用二维码工具生成）：</p>
          <p className="panel-relay__link"><code>{remote.viewerLink}</code></p>
          <div className="dialog__actions">
            <ToolbarButton icon="⧉" label={copied ? "已复制" : "复制链接"} onClick={() => { onCopy(); onCopied(); }} />
            <ToolbarButton icon="✕" label="结束远程观众" variant="danger" onClick={onEnd} />
          </div>
          {remote.pending.length > 0 ? (
            <section className="panel-relay__pending" aria-label="等待批准的观众">
              <h3>等待批准</h3>
              {remote.pending.map((viewer) => (
                <div key={viewer.viewerId}>
                  <span>{viewer.displayName}</span>
                  <ToolbarButton icon="✓" label="批准" variant="primary" onClick={() => onApprove(viewer.viewerId)} />
                  <ToolbarButton icon="✕" label="拒绝" onClick={() => onReject(viewer.viewerId)} />
                </div>
              ))}
            </section>
          ) : null}
          {remote.viewerCount > 0 ? (
            <p>当前远程观众 {remote.viewerCount} 人（在设置中可断开）。</p>
          ) : (
            <p>还没有观众加入。</p>
          )}
        </>
      ) : (
        <>
          <p>填写观众中继服务地址。局域网部署在内网主机，公网部署使用域名（HTTPS）。</p>
          <label className="field">
            <span>中继地址（如 http://192.168.1.10:8787 或 https://demo.example.com）</span>
            <input autoFocus value={value} placeholder="http://192.168.1.10:8787" onChange={(event) => onChange(event.target.value)} />
          </label>
          <div className="dialog__actions">
            <ToolbarButton icon="🌐" label="开启远程观众" variant="primary" disabled={!value.trim().startsWith("http")} onClick={onOpen} />
          </div>
          <p className="panel-relay__hint">中继服务随 Showit 交付（apps/relay），一条 Docker 命令即可部署；观众无需安装任何软件。</p>
        </>
      )}
    </Dialog>
  );
}

function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <Dialog title="键盘快捷键" onClose={onClose}>
      <ul className="panel-shortcuts">
        <li><kbd>←</kbd>/<kbd>→</kbd> 上一页 / 下一页</li>
        <li><kbd>↑</kbd>/<kbd>↓</kbd> 上一步骤 / 下一步骤</li>
        <li><kbd>空格</kbd> 开始 / 暂停计时</li>
        <li><kbd>L</kbd> 激光笔 · <kbd>C</kbd> 圈选标注</li>
        <li><kbd>B</kbd> 黑屏 · <kbd>W</kbd> 白屏 · <kbd>F</kbd> 冻结 · <kbd>P</kbd> 隐私遮挡</li>
        <li><kbd>A</kbd> 自动翻页开关 · <kbd>R</kbd> 排练</li>
        <li><kbd>Esc</kbd> 逐级退出（对话框 → 编辑 → 标注 → 屏幕模式）</li>
      </ul>
    </Dialog>
  );
}
