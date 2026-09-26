import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Circle,
  Crosshair,
  Eraser,
  EyeOff,
  ExternalLink,
  Grid2X2,
  HardDriveDownload,
  LogIn,
  RefreshCw,
  ScanEye,
  ScanSearch,
  ShieldCheck,
  ShieldOff,
  TriangleAlert
} from "lucide-react";
import { validateBusinessUrlTemplate, type PresentationPage, type PresentationSession, type Project } from "@showit/contracts";
import { ToolbarButton } from "../../components/ToolbarButton";
import { resolveUrlTemplate } from "../../lib/template";
import { AnnotationLayer } from "./AnnotationLayer";
import { PrivacyMaskLayer } from "./PrivacyMaskLayer";
import { BusinessPreview } from "./BusinessPreview";
import { OfflineFallback } from "../../components/OfflineFallback";
import { isOfflineFallbackReady } from "../../lib/offline-fallback";
import { checkBusinessUrl, configureReadonlyProxy, openBusinessBrowser, type BusinessUrlHealth } from "../../lib/persistence";
import { probeConnectorSession, supportsConnectorSessionProbe, type ConnectorSessionState } from "../../lib/connector-session";

type BusinessStageProps = {
  project: Project;
  session: PresentationSession;
  page: PresentationPage;
  pageGridOpen: boolean;
  onPageSelect: (index: number) => void;
  onPageGridOpenChange: (open: boolean) => void;
  onUrlChange: (url: string | undefined) => void;
  onAnnotationTool: (tool: PresentationSession["annotationTool"]) => void;
  onLaser: (laser: PresentationSession["laser"]) => void;
  onCircle: (circle: PresentationSession["circles"][number]) => void;
  onMask: (mask: PresentationPage["privacyMasks"][number]) => void;
  onBindMask: (mode: "solid" | "blur") => void;
  maskPickerActive: boolean;
  onClear: () => void;
  onClearMasks: () => void;
  onOfflineFallback: (active: boolean) => void;
  onOfflineNetworkOriginRequest: (origin: string) => void;
  connectorState: { state: string; role?: string; title?: string; reason?: string; resourceFailures?: number } | null;
  onReadinessChange: (ready: boolean) => void;
};

export function BusinessStage({
  project,
  session,
  page,
  pageGridOpen,
  onPageSelect,
  onPageGridOpenChange,
  onUrlChange,
  onAnnotationTool,
  onLaser,
  onCircle,
  onMask,
  onBindMask,
  maskPickerActive,
  onClear,
  onClearMasks,
  onOfflineFallback,
  onOfflineNetworkOriginRequest,
  connectorState,
  onReadinessChange
}: BusinessStageProps) {
  const [frameKey, setFrameKey] = useState(0);
  const [frameOpen, setFrameOpen] = useState(false);
  const [frameState, setFrameState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [usingFallback, setUsingFallback] = useState(false);
  const [urlDraft, setUrlDraft] = useState(page.url ?? "");
  const [maskMode, setMaskMode] = useState<"solid" | "blur">("solid");
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [loadHealth, setLoadHealth] = useState<BusinessUrlHealth | null>(null);
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const [sessionAccess, setSessionAccess] = useState<ConnectorSessionState | { state: "checking" } | null>(null);
  const sessionCheckSequence = useRef(0);
  const frameElement = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    setUrlDraft(page.url ?? "");
    setFrameOpen(Boolean(page.url));
    setFrameState("idle");
    setUsingFallback(false);
    setLoadHealth(null);
    setProxyUrl(null);
    setBrowserError(null);
    setSessionAccess(null);
    sessionCheckSequence.current += 1;
  }, [page.id, page.url]);

  const urlState = useMemo(() => validateBusinessUrlTemplate(urlDraft), [urlDraft]);
  const connector = project.connectors.find((candidate) => candidate.id === page.connectorId) ?? project.connectors[0];
  const sandbox = connector?.sandboxPermissions.join(" ") ?? "allow-scripts allow-same-origin";
  const primaryUrl = useMemo(() => page.url ? resolveUrlTemplate(page.url, project, page) : null, [page, project]);
  const fallbackUrl = useMemo(() => page.fallbackUrl ? resolveUrlTemplate(page.fallbackUrl, project, page) : null, [page, project]);
  const activeUrl = usingFallback ? fallbackUrl : primaryUrl;
  const activeUrlValue = activeUrl?.ok ? activeUrl.value : null;
  const requiresReadonlyProxy = connector?.securityMode === "readonly-proxy";
  const offlineActive = session.offlineFallbackPageId === page.id && isOfflineFallbackReady(page.offline);
  const sessionAllowedNetworkOrigins = session.offlineNetworkGrants
    .filter((grant) => grant.pageId === page.id)
    .map((grant) => grant.origin);
  const opensInFrame = !connector || connector.mode === "iframe";
  const frameTargetUrl = requiresReadonlyProxy ? proxyUrl : activeUrlValue;
  // Keep the frame mounted across audience screen modes: the .screen-cover
  // overlay conceals it visually, and unmounting would destroy the live
  // business page state (login, SPA state) every time the presenter toggles
  // freeze/blackout and back.
  const canRenderFrame = Boolean(!offlineActive && frameOpen && opensInFrame && frameTargetUrl);
  const connectionLabel = connectorState
    ? connectorState.state === "ready" ? "扩展已就绪"
      : connectorState.state === "anonymous" ? "需要登录"
        : connectorState.state === "role-mismatch" ? "角色不匹配"
          : connectorState.state === "blocked" ? "控制已暂停"
            : connectorState.state === "error" ? "扩展不可用"
              : "正在检查扩展"
    : opensInFrame
      ? sessionAccess?.state === "anonymous" ? "需要登录"
        : sessionAccess?.state === "role-mismatch" ? "角色不匹配"
          : sessionAccess?.state === "error" ? "会话检查失败"
            : sessionAccess?.state === "checking" ? "正在检查角色"
              : sessionAccess?.state === "ready" ? "角色就绪"
                : frameState === "ready" ? "只读页面已就绪"
        : frameState === "loading" ? "正在加载只读页面"
          : frameState === "error" ? "业务页不可用"
            : "准备只读页面"
      : "独立窗口模式";
  const sessionAccessReason = sessionAccess && "reason" in sessionAccess ? sessionAccess.reason : null;

  useEffect(() => {
    setProxyUrl(null);
    if (!requiresReadonlyProxy || !connector || !activeUrlValue) return;
    let current = true;
    configureReadonlyProxy(project.id, connector, activeUrlValue)
      .then((url) => { if (current) setProxyUrl(url); })
      .catch((error) => {
        if (!current) return;
        setBrowserError(error instanceof Error ? error.message : "只读代理无法启动。");
        setFrameState("error");
      });
    return () => { current = false; };
  }, [activeUrlValue, connector, page.id, project.id, requiresReadonlyProxy]);

  useEffect(() => {
    const currentIndex = project.pages.findIndex((candidate) => candidate.id === page.id);
    const nextPage = project.pages.slice(currentIndex + 1).find((candidate) => candidate.enabled && candidate.url);
    if (!nextPage) return;
    const nextConnector = project.connectors.find((candidate) => candidate.id === nextPage.connectorId);
    const nextUrl = resolveUrlTemplate(nextPage.url!, project, nextPage);
    if (!nextUrl.ok || nextConnector?.mode !== "iframe" || nextConnector.securityMode === "readonly-proxy") return;
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.as = "document";
    link.href = nextUrl.value;
    link.referrerPolicy = "no-referrer";
    document.head.append(link);
    return () => link.remove();
  }, [page.id, project]);

  useEffect(() => {
    const accessReady = !sessionAccess || sessionAccess.state === "ready";
    const frameReady = !opensInFrame || !activeUrlValue || (frameState === "ready" && accessReady);
    onReadinessChange((page.pageType === "end" || offlineActive || frameReady) && browserError === null);
    return () => onReadinessChange(false);
  }, [activeUrlValue, browserError, frameState, offlineActive, onReadinessChange, opensInFrame, page.id, page.pageType, sessionAccess]);

  const checkFrameSession = useCallback(() => {
    if (!connector || !frameTargetUrl || !supportsConnectorSessionProbe(connector)) {
      setSessionAccess(null);
      return;
    }
    const sequence = ++sessionCheckSequence.current;
    setSessionAccess({ state: "checking" });
    void probeConnectorSession(frameTargetUrl, page.role, connector).then((result) => {
      if (sessionCheckSequence.current === sequence) setSessionAccess(result);
    });
  }, [connector, frameTargetUrl, page.role]);

  useEffect(() => {
    if (!frameTargetUrl || !connector || !supportsConnectorSessionProbe(connector)) return;
    const frameOrigin = new URL(frameTargetUrl).origin;
    const onMessage = (event: MessageEvent<unknown>) => {
      const payload = event.data as { __showitConnectorSession?: unknown } | null;
      if (event.origin !== frameOrigin || event.source !== frameElement.current?.contentWindow || payload?.__showitConnectorSession !== 1) return;
      checkFrameSession();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [checkFrameSession, connector, frameTargetUrl]);

  const handleFrameLoad = () => {
    setFrameState("ready");
    checkFrameSession();
  };

  useEffect(() => {
    if (!canRenderFrame) return;
    setFrameState("loading");
    const timeout = window.setTimeout(() => setFrameState((state) => state === "loading" ? "error" : state), 12_000);
    return () => window.clearTimeout(timeout);
  }, [canRenderFrame, frameKey, page.id, usingFallback]);

  useEffect(() => {
    if (frameState !== "error" || !activeUrl?.ok) return;
    let current = true;
    setLoadHealth(null);
    checkBusinessUrl(activeUrl.value).then((health) => { if (current) setLoadHealth(health); }).catch(() => undefined);
    return () => { current = false; };
  }, [activeUrl, frameState]);

  const openBusinessWindow = async (url = activeUrl?.ok ? activeUrl.value : null) => {
    if (!url) return;
    setBrowserError(null);
    try {
      const target = requiresReadonlyProxy && connector ? await configureReadonlyProxy(project.id, connector, url) : url;
      await openBusinessBrowser(target, project.id, session.browserSessionMode === "dedicated", requiresReadonlyProxy);
    } catch (error) {
      setBrowserError(error instanceof Error ? error.message : "无法打开业务浏览器。");
    }
  };

  return (
    <section className="business-stage" aria-label="业务系统画面">
      <div className="stage-toolbar">
        <div className="stage-title">
          <strong>{page.businessLabel}</strong>
          <span>
            {page.role} · {session.screenMode === "normal" ? "交互模式" : "观众屏受控"}
          </span>
        </div>
        <form
          className="stage-url-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (urlState.valid) {
              const draftUrl = urlDraft.trim();
              const resolvedDraft = resolveUrlTemplate(draftUrl, project, page);
              onUrlChange(draftUrl);
              setUsingFallback(false);
              if (opensInFrame) setFrameOpen(true);
              else if (resolvedDraft.ok) openBusinessWindow(resolvedDraft.value);
            }
          }}
        >
          <input
            aria-label="业务系统 URL"
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            onBlur={() => {
              if (urlDraft.trim() === "") onUrlChange(undefined);
              if (urlState.valid) onUrlChange(urlDraft.trim());
            }}
          />
          <button type="submit" disabled={!urlState.valid || !urlDraft.trim()}>
            应用
          </button>
        </form>
        <div className="stage-actions">
          <ToolbarButton
            icon={<Grid2X2 size={16} />}
            label="页面"
            title="打开页面选择网格"
            active={pageGridOpen}
            onClick={() => onPageGridOpenChange(!pageGridOpen)}
          />
          <ToolbarButton
            icon={<RefreshCw size={16} />}
            label="刷新"
            title="刷新业务画面"
            onClick={() => {
              setFrameKey((key) => key + 1);
              setFrameOpen(true);
              setFrameState("loading");
              setSessionAccess(null);
              sessionCheckSequence.current += 1;
            }}
          />
          <ToolbarButton icon={<LogIn size={16} />} label="系统登录" title="在独立业务窗口中登录或聚焦" disabled={!activeUrl?.ok} onClick={() => openBusinessWindow()} />
          <ToolbarButton icon={<HardDriveDownload size={16} />} label="备用" title="切换当前页离线备用内容" disabled={!isOfflineFallbackReady(page.offline)} active={offlineActive} onClick={() => onOfflineFallback(!offlineActive)} />
          <ToolbarButton
            icon={<Crosshair size={16} />}
            label="激光"
            title="启用激光笔（L）"
            active={session.annotationTool === "laser"}
            onClick={() => onAnnotationTool(session.annotationTool === "laser" ? "none" : "laser")}
          />
          <ToolbarButton
            icon={<Circle size={16} />}
            label="圈选"
            title="启用圈选（C）"
            active={session.annotationTool === "circle"}
            onClick={() => onAnnotationTool(session.annotationTool === "circle" ? "none" : "circle")}
          />
          <ToolbarButton
            icon={<EyeOff size={16} />}
            label="遮罩"
            title="框选仅观众可见的隐私遮罩"
            active={session.annotationTool === "mask"}
            onClick={() => onAnnotationTool(session.annotationTool === "mask" ? "none" : "mask")}
          />
          <ToolbarButton icon={<ScanEye size={16} />} label="模糊" title="切换新建隐私遮罩为实色或模糊" active={maskMode === "blur"} onClick={() => setMaskMode((mode) => mode === "solid" ? "blur" : "solid")} />
          <ToolbarButton icon={<ScanSearch size={16} />} label="绑定" title="在业务标签中选择需要持续遮挡的元素" active={maskPickerActive} disabled={maskPickerActive} onClick={() => onBindMask(maskMode)} />
          <ToolbarButton icon={<Eraser size={16} />} label="清除" title="清除标注（X）" onClick={onClear} />
          <ToolbarButton icon={<ShieldOff size={16} />} title="清除当前页隐私遮罩" disabled={page.privacyMasks.length === 0} onClick={onClearMasks} />
        </div>
      </div>

      {pageGridOpen ? (
        <div className="page-grid" role="listbox" aria-label="页面选择">
          {project.pages.map((candidate, index) => (
            <button
              key={candidate.id}
              type="button"
              className={index === session.currentPageIndex ? "is-current" : ""}
              onClick={() => {
                onPageSelect(index);
                onPageGridOpenChange(false);
              }}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{candidate.title}</strong>
              <small>{candidate.role}</small>
            </button>
          ))}
        </div>
      ) : null}

      <div className="business-frame-wrap">
        <div className="stage-status-strip">
          <span>
            <ShieldCheck size={14} /> {connector?.name ?? "未配置连接器"} · {connectionLabel}
          </span>
          <span>{browserError ?? connectorState?.reason ?? sessionAccessReason ?? connectorState?.role ?? connectorState?.title ?? (frameState === "loading" ? "正在加载业务页" : frameState === "ready" ? usingFallback ? "备用业务页已加载" : "业务页已加载" : activeUrl && !activeUrl.ok ? activeUrl.errors[0] : urlState.valid ? "离线参考画面" : urlState.reason)}{connectorState?.resourceFailures ? ` · 资源失败 ${connectorState.resourceFailures}` : ""}</span>
          {activeUrl?.ok ? (
            <button type="button" className="stage-external-link" onClick={() => openBusinessWindow()}>
              新窗口 <ExternalLink size={13} />
            </button>
          ) : null}
        </div>
        {page.pageType === "end" ? <section className="business-end-page"><strong>{project.brand.endTitle}</strong><span>{project.brand.endDescription}</span></section> : offlineActive ? <OfflineFallback fallback={page.offline} label={project.brand.offlineLabel} sessionAllowedNetworkOrigins={sessionAllowedNetworkOrigins} onNetworkOriginRequest={onOfflineNetworkOriginRequest} /> : canRenderFrame ? (
          <iframe
            ref={frameElement}
            key={`${page.id}-${frameKey}-${usingFallback ? "fallback" : "primary"}`}
            title={page.title}
            src={frameTargetUrl ?? undefined}
            sandbox={sandbox}
            referrerPolicy="origin"
            onLoad={handleFrameLoad}
            onError={() => setFrameState("error")}
          />
        ) : (
          <BusinessPreview project={project} page={page} />
        )}
        {frameState === "error" && session.screenMode === "normal" ? (
          <div className="business-frame-error" role="alert">
            <TriangleAlert size={22} />
            <strong>业务页面未能加载</strong>
            <span>{activeUrl?.ok ? activeUrl.value : "URL 无效"}</span>
            <span>{connector?.name ?? "未配置连接器"} · {loadHealth ? loadHealth.status !== null ? `HTTP ${loadHealth.status}` : loadHealth.error ?? "无法连接" : "正在检查 HTTP 状态"}</span>
            <div>
              <button type="button" onClick={() => { setFrameKey((key) => key + 1); setFrameState("loading"); setSessionAccess(null); sessionCheckSequence.current += 1; }}>重试</button>
              {fallbackUrl?.ok && !usingFallback ? <button type="button" onClick={() => { setUsingFallback(true); setFrameKey((key) => key + 1); }}>备用 URL</button> : null}
              <button type="button" onClick={() => openBusinessWindow()}>新窗口</button>
            </div>
          </div>
        ) : null}
        {session.screenMode !== "normal" ? (
          <div className={`screen-cover screen-cover--${session.screenMode}`}>
            <strong>观众屏已切换状态</strong>
            <span>演讲者仍可继续操作和翻页。</span>
          </div>
        ) : null}
        <AnnotationLayer
          interactive={session.screenMode === "normal"}
          tool={session.annotationTool}
          circles={session.circles}
          laser={session.laser}
          onLaser={onLaser}
          onCircle={onCircle}
          onMask={(mask) => onMask({ ...mask, mode: maskMode })}
        />
        <PrivacyMaskLayer masks={page.privacyMasks} presenterPreview />
      </div>

      <footer className="stage-page-meta">
        <strong>{page.title}</strong>
        <span>
          {page.role} · 第 {session.currentPageIndex + 1} 页 · {session.screenMode === "normal" ? connectionLabel : "屏幕控制中"}
        </span>
      </footer>
    </section>
  );
}
