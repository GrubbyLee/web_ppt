import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfigProvider, Drawer, InputNumber, Segmented, Switch, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import QRCode from "qrcode";
import { Bug, Copy, Download, Monitor, PanelsLeftBottom, Radio, RefreshCw, ShieldCheck, Square, Timer, Trash2, UserCheck, UserRoundX, UserX, Wifi, WifiOff } from "lucide-react";
import type { PresentationSession, Project, Rehearsal, ScreenMode } from "@showit/contracts";
import { formatDuration } from "../../lib/format";
import { screenModeLabel } from "../../lib/format";
import { runProjectPreflight } from "../../lib/preflight";
import { downloadPreflightReport, downloadRehearsalReport } from "../../lib/export";
import { checkBusinessUrl, clearDedicatedBrowserProfile, getDedicatedBrowserProfileStatus, type AudienceNetworkInterface, type AudienceSessionStatus, type AudienceShare, type BrowserProfileStatus } from "../../lib/persistence";
import { resolveUrlTemplate } from "../../lib/template";
import { clearDiagnostics, downloadDiagnostics, listAllDiagnostics, type DiagnosticEntry } from "../../lib/diagnostics";

type SettingsDrawerProps = {
  open: boolean;
  project: Project;
  session: PresentationSession;
  rehearsals: Rehearsal[];
  audienceShareUrl: string | null;
  audienceShare: AudienceShare | null;
  audienceSessionStatus: AudienceSessionStatus | null;
  audienceNetworkInterfaces: AudienceNetworkInterface[];
  audienceNetworkAddress: string;
  onAudienceNetworkAddress: (address: string) => void;
  onStartAudienceShare: () => void;
  onStopAudienceShare: () => void;
  onDecideViewer: (viewerId: string, approve: boolean) => void;
  onDisconnectViewer: (viewerId: string) => void;
  onDisconnectAllViewers: () => void;
  onClose: () => void;
  onAutoAdvance: (enabled: boolean) => void;
  onAutoAdvanceSeconds: (seconds: number) => void;
  onCurrentPageAutoAdvanceSeconds: (seconds: number | undefined) => void;
  onBrowserSessionMode: (mode: PresentationSession["browserSessionMode"]) => void;
  onLayoutPreset: (preset: Project["layout"]["preset"]) => void;
  onStagePercent: (value: number) => void;
  onScreenMode: (mode: ScreenMode) => void;
  scrollToPreflight?: boolean;
};

const screenModes: ScreenMode[] = ["normal", "black", "white", "frozen", "privacy", "ended"];

export function SettingsDrawer({
  open,
  project,
  session,
  rehearsals,
  audienceShareUrl,
  audienceShare,
  audienceSessionStatus,
  audienceNetworkInterfaces,
  audienceNetworkAddress,
  onAudienceNetworkAddress,
  onStartAudienceShare,
  onStopAudienceShare,
  onDecideViewer,
  onDisconnectViewer,
  onDisconnectAllViewers,
  onClose,
  onAutoAdvance,
  onAutoAdvanceSeconds,
  onCurrentPageAutoAdvanceSeconds,
  onBrowserSessionMode,
  onLayoutPreset,
  onStagePercent,
  onScreenMode,
  scrollToPreflight = false
}: SettingsDrawerProps) {
  const preflight = useMemo(() => runProjectPreflight(project), [project]);
  useEffect(() => {
    if (!open || !scrollToPreflight) return;
    const timer = window.setTimeout(() => {
      document.getElementById("settings-preflight")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [open, scrollToPreflight]);
  const [healthItems, setHealthItems] = useState<Array<{ id: string; state: "ok" | "warn" | "error"; message: string }>>([]);
  const [healthChecking, setHealthChecking] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([]);
  const [profileStatus, setProfileStatus] = useState<BrowserProfileStatus | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [audienceQrCode, setAudienceQrCode] = useState<string | null>(null);
  const healthRun = useRef(0);
  const runHealthChecks = useCallback(async () => {
    const runId = ++healthRun.current;
    setHealthChecking(true);
    const items = new Array<{ id: string; state: "ok" | "warn" | "error"; message: string }>(project.pages.length);
    let nextIndex = 0;
    const checkNext = async (): Promise<void> => {
      const index = nextIndex++;
      if (index >= project.pages.length) return;
      const page = project.pages[index]!;
      if (!page.url) {
        items[index] = { id: page.id, state: "warn", message: `${page.title}：离线参考画面` };
      } else {
        const resolved = resolveUrlTemplate(page.url, project, page);
        if (!resolved.ok) {
          items[index] = { id: page.id, state: "error", message: `${page.title}：${resolved.errors[0] ?? "URL 模板无效"}` };
        } else {
          const health = await checkBusinessUrl(resolved.value);
          const state = health.ok ? "ok" as const : health.mode === "browser" && health.status === null ? "warn" as const : "error" as const;
          const result = health.status !== null ? `HTTP ${health.status} · ${health.elapsedMs} ms` : health.error ?? "无法连接";
          const title = health.title ? ` · ${health.title}` : "";
          items[index] = { id: page.id, state, message: `${page.title}：${result}${title}` };
        }
      }
      if (healthRun.current === runId) await checkNext();
    };
    await Promise.all(Array.from({ length: Math.min(4, project.pages.length) }, () => checkNext()));
    if (healthRun.current !== runId) return;
    setHealthItems(items);
    setHealthChecking(false);
  }, [project]);

  useEffect(() => {
    if (open) void runHealthChecks();
    else {
      healthRun.current += 1;
      setHealthChecking(false);
    }
    return () => { healthRun.current += 1; };
  }, [open, runHealthChecks]);
  useEffect(() => {
    if (open) void listAllDiagnostics().then(setDiagnostics);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    getDedicatedBrowserProfileStatus(project.id).then(setProfileStatus).catch(() => setProfileStatus(null));
  }, [open, project.id]);
  useEffect(() => {
    let active = true;
    if (!open || !audienceShareUrl) {
      setAudienceQrCode(null);
      return () => { active = false; };
    }
    QRCode.toDataURL(audienceShareUrl, { errorCorrectionLevel: "M", margin: 1, width: 168, color: { dark: "#091015", light: "#f4f8f8" } })
      .then((value) => { if (active) setAudienceQrCode(value); })
      .catch(() => { if (active) setAudienceQrCode(null); });
    return () => { active = false; };
  }, [audienceShareUrl, open]);
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: "#37d0ba",
          colorInfo: "#82a7ff",
          colorWarning: "#f4b44d",
          colorError: "#ff5f6d",
          borderRadius: 8,
          fontFamily: "Inter, Noto Sans SC, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        }
      }}
    >
      <Drawer
      title="演示设置"
      placement="right"
      width={420}
      open={open}
      onClose={onClose}
      rootClassName="showit-drawer"
      destroyOnClose={false}
      >
      <section className="settings-section">
        <h2>
          <Timer size={16} /> 自动翻页
        </h2>
        <label className="settings-row">
          <span>总开关</span>
          <Switch checked={project.autoAdvanceEnabled} onChange={onAutoAdvance} />
        </label>
        <label className="settings-row">
          <span>全局间隔</span>
          <InputNumber
            min={1}
            max={14_400}
            value={project.autoAdvanceSeconds}
            addonAfter="秒"
            onChange={(value) => onAutoAdvanceSeconds(Number(value ?? 90))}
          />
        </label>
        <label className="settings-row">
          <span>当前页覆盖</span>
          <InputNumber
            min={1}
            max={14_400}
            value={project.pages[session.currentPageIndex]?.autoAdvanceSeconds ?? null}
            addonAfter="秒"
            placeholder="继承全局"
            onChange={(value) => onCurrentPageAutoAdvanceSeconds(value === null ? undefined : Number(value))}
          />
        </label>
      </section>

      <section className="settings-section">
        <h2>
          <PanelsLeftBottom size={16} /> 布局
        </h2>
        <Segmented
          block
          value={project.layout.preset}
          onChange={(value) => onLayoutPreset(value as Project["layout"]["preset"])}
          options={[
            { label: "页面优先", value: "stage" },
            { label: "均衡", value: "balanced" },
            { label: "备注优先", value: "notes" }
          ]}
        />
        <label className="settings-row">
          <span>业务区宽度</span>
          <InputNumber min={50} max={66} value={Math.min(66, Math.max(50, project.layout.stagePercent))} addonAfter="%" onChange={(value) => onStagePercent(Number(value ?? 56))} />
        </label>
      </section>

      <section className="settings-section">
        <h2><Monitor size={16} /> 浏览器会话</h2>
        <Segmented block value={session.browserSessionMode} onChange={(value) => onBrowserSessionMode(value as PresentationSession["browserSessionMode"])} options={[{ label: "日常浏览器", value: "daily" }, { label: "专用演示环境", value: "dedicated" }]} />
        <div className="browser-profile-status">
          <span>{profileStatus?.exists ? `专用目录 ${(profileStatus.bytes / 1024 / 1024).toFixed(1)} MB` : "尚未创建专用目录"}</span>
          <button type="button" disabled={!profileStatus?.exists} onClick={() => {
            setProfileError(null);
            clearDedicatedBrowserProfile(project.id)
              .then(() => setProfileStatus({ exists: false, bytes: 0 }))
              .catch((error) => setProfileError(error instanceof Error ? error.message : "专用目录清理失败"));
          }}><Trash2 size={14} />清理</button>
        </div>
        {profileError ? <p className="settings-error">{profileError}</p> : null}
      </section>

      <section className="settings-section">
        <h2>
          <Monitor size={16} /> 观众屏状态
        </h2>
        <div className="screen-mode-grid">
          {screenModes.map((mode) => (
            <button
              key={mode}
              type="button"
              className={session.screenMode === mode ? "is-active" : ""}
              onClick={() => onScreenMode(mode)}
            >
              {screenModeLabel(mode)}
            </button>
          ))}
        </div>
        <div className="lan-share">
          {audienceShareUrl ? (
            <>
              <span className="lan-share__count">在线 {audienceSessionStatus?.audienceCount ?? session.audienceCount}/{audienceSessionStatus?.capacity ?? (project.audienceCapacityMode === "sfu-20" ? 20 : 5)}</span>
              <code>{audienceShareUrl}</code>
              <button type="button" aria-label="复制局域网观众链接" title="复制局域网观众链接" onClick={() => void navigator.clipboard.writeText(audienceShareUrl)}><Copy size={15} /></button>
              <button type="button" aria-label="停止局域网分享" title="停止局域网分享" onClick={onStopAudienceShare}><Square size={14} /></button>
            </>
          ) : (
            <button type="button" className="lan-share__start" onClick={onStartAudienceShare}><Radio size={15} />启动局域网分享</button>
          )}
        </div>
        <label className="settings-row audience-network-select">
          <span>网络接口</span>
          <select value={audienceNetworkAddress} disabled={Boolean(audienceShareUrl)} onChange={(event) => onAudienceNetworkAddress(event.target.value)}>
            {audienceNetworkInterfaces.map((network) => <option key={network.address} value={network.address}>{network.name} · {network.address}{network.isDefault ? "（默认）" : ""}</option>)}
          </select>
        </label>
        {audienceShareUrl ? (
          <div className="audience-share-details">
            {audienceQrCode ? <img src={audienceQrCode} alt="局域网观众链接二维码" /> : null}
            <dl>
              <div><dt>容量模式</dt><dd>{audienceShare?.deliveryMode === "sfu" ? "本地 SFU" : "点对点"} {audienceSessionStatus?.capacity ?? (project.audienceCapacityMode === "sfu-20" ? 20 : 5)} 人</dd></div>
              <div><dt>网络接口</dt><dd>{audienceShare?.networkName ?? "本机"} · {audienceShare?.networkAddress ?? new URL(audienceShareUrl).hostname}</dd></div>
            </dl>
          </div>
        ) : null}
        {audienceShareUrl ? (
          <div className="audience-viewer-list" aria-label="当前观众">
            {(audienceSessionStatus?.viewers.length ?? 0) > 0 ? <button type="button" className="audience-viewer-list__disconnect-all" onClick={onDisconnectAllViewers}><UserRoundX size={14} />断开全部</button> : null}
            {(audienceSessionStatus?.viewers.length ?? 0) === 0 ? <p>暂无观众</p> : audienceSessionStatus?.viewers.map((viewer) => (
              <div key={viewer.id} data-state={viewer.status}>
                <span><strong>{viewer.displayName}</strong><small>{viewer.ip} · {viewer.status === "pending" ? "等待批准" : viewer.status === "approved" ? "正在连接" : `已连接 · ${viewer.quality === "good" ? "质量良好" : viewer.quality === "fair" ? "质量一般" : viewer.quality === "poor" ? "质量较差" : "正在测量"}`}</small></span>
                {viewer.status === "pending" ? <><button type="button" aria-label={`批准 ${viewer.displayName}`} title={`批准 ${viewer.displayName}`} onClick={() => onDecideViewer(viewer.id, true)}><UserCheck size={14} /></button><button type="button" aria-label={`拒绝 ${viewer.displayName}`} title={`拒绝 ${viewer.displayName}`} onClick={() => onDecideViewer(viewer.id, false)}><UserX size={14} /></button></> : <button type="button" aria-label={`断开 ${viewer.displayName}`} title={`断开 ${viewer.displayName}`} onClick={() => onDisconnectViewer(viewer.id)}><WifiOff size={14} /></button>}
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="settings-section" id="settings-preflight">
        <h2>
          <ShieldCheck size={16} /> 演前检查
          <button type="button" aria-label="导出演前记录" title="导出演前记录" onClick={() => downloadPreflightReport(project, preflight, healthItems)}><Download size={14} /></button>
        </h2>
        <ul className="preflight-list">
          {preflight.items.map((item) => <li key={item.id} data-state={item.state}>{item.message}</li>)}
        </ul>
      </section>

      <section className="settings-section">
        <h2>
          <RefreshCw size={16} /> 业务连接检测
          <button type="button" aria-label="重新检查业务连接" title="重新检查业务连接" disabled={healthChecking} onClick={() => void runHealthChecks()}><RefreshCw size={14} /></button>
        </h2>
        {healthChecking && healthItems.length === 0 ? <p className="settings-empty">正在检查业务页面...</p> : <ul className="preflight-list health-list">{healthItems.map((item) => <li key={item.id} data-state={item.state}>{item.message}</li>)}</ul>}
      </section>

      <section className="settings-section">
        <h2>
          <Wifi size={16} /> 快捷键
        </h2>
        <dl className="shortcut-list">
          <div>
            <dt>Space</dt>
            <dd>开始/暂停计时</dd>
          </div>
          <div>
            <dt>← / → / ↑ / ↓</dt>
            <dd>切换页面</dd>
          </div>
          <div>
            <dt>PageUp / PageDown / Home / End</dt>
            <dd>翻页或跳到首尾</dd>
          </div>
          <div>
            <dt>L / C / X</dt>
            <dd>激光笔、圈选、清除标注</dd>
          </div>
          <div>
            <dt>P</dt>
            <dd>提词模式（大字号脚本）</dd>
          </div>
          <div>
            <dt>B / W / F</dt>
            <dd>黑屏、白屏、冻结</dd>
          </div>
          <div>
            <dt>Esc</dt>
            <dd>恢复观众屏、退出标注或打开页面网格</dd>
          </div>
          <div>
            <dt>A / R / ?</dt>
            <dd>自动翻页、排练、快捷键帮助</dd>
          </div>
        </dl>
      </section>

      <section className="settings-section">
        <h2>
          <Bug size={16} /> 本机诊断
          <button type="button" aria-label="导出脱敏诊断记录" title="导出脱敏诊断记录" disabled={diagnostics.length === 0} onClick={() => void downloadDiagnostics()}><Download size={14} /></button>
          <button type="button" aria-label="清理诊断记录" title="清理诊断记录" disabled={diagnostics.length === 0} onClick={() => { clearDiagnostics(); setDiagnostics([]); }}><Trash2 size={14} /></button>
        </h2>
        <p className="settings-empty">导出包含已脱敏的运行时与桌面本机服务诊断，不包含截图、视频和业务内容。</p>
        {diagnostics.length === 0 ? <p className="settings-empty">暂无诊断记录</p> : <div className="diagnostic-list">{diagnostics.slice(0, 5).map((entry) => <div key={entry.traceId}><code>{entry.traceId}</code><span>{entry.area}</span><small>{new Date(entry.at).toLocaleString("zh-CN")}</small></div>)}</div>}
      </section>

      <section className="settings-section">
        <h2>
          <Timer size={16} /> 最近排练
        </h2>
        {rehearsals.length === 0 ? <p className="settings-empty">暂无排练记录</p> : (
          <div className="rehearsal-list">
            {rehearsals.slice(0, 5).map((rehearsal) => {
              const overrunPages = rehearsal.pages.filter((page) => page.actualMs > page.plannedMs).length;
              return <div key={rehearsal.id}><span>{new Date(rehearsal.endedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span><strong>{formatDuration(rehearsal.totalElapsedMs)}</strong><small>{overrunPages} 页超时</small><button type="button" aria-label="导出排练报告" title="导出排练报告" onClick={() => downloadRehearsalReport(project, rehearsal)}><Download size={14} /></button>{rehearsal.note ? <p className="rehearsal-note">{rehearsal.note}</p> : null}</div>;
            })}
          </div>
        )}
      </section>
      </Drawer>
    </ConfigProvider>
  );
}
