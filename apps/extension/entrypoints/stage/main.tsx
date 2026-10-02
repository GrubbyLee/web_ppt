import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import type { BgMessage, BroadcastState, UiMessage } from "@/messaging/protocol";
import { PORT_PREFIX } from "@/messaging/protocol";
import { OfflineFallbackView } from "@/components/OfflineFallbackView";
import { attachAnnotationLayer, createOverlayRenderer, lockPageSelection, makeCircleId } from "@/lib/dom-connector";
import "@/components/ui.css";
import "./stage.css";

const overlayRenderer = createOverlayRenderer();
let annotationLayer: { detach(): void; cancel(): void } | null = null;

/**
 * 舞台页（固定页 / 章节页）的标注也走覆盖层渲染，与业务页、内置演示页共用同一套
 * 圆点、遮罩与激光笔样式，不再各自画一份。
 *
 * 封面、隐私、结束等整屏遮罩仍由 React 渲染（结束页要显示品牌 Logo），所以这里只在
 * 正常画面时交给覆盖层，避免两层遮罩叠加。
 */
function renderStageOverlay(state: BroadcastState): void {
  const machine = state.machine;
  const page = machine.project.pages[machine.session.currentPageIndex] ?? null;
  const offline = Boolean(page && machine.session.offlineFallbackPageId === page.id);
  const screenMode = machine.session.screenMode;
  // 整屏遮罩（mask）由覆盖层渲染：它是全屏封面，会盖住下面的幻灯片。
  if (screenMode === "mask") {
    overlayRenderer.render({
      screenMode: "mask",
      privacyMessage: machine.project.brand.privacyMessage,
      privacyMasks: [],
      circles: [],
      mask: { title: machine.project.brand.maskTitle, ...(machine.project.brand.maskImageDataUrl ? { imageDataUrl: machine.project.brand.maskImageDataUrl } : {}) }
    });
    return;
  }
  // 黑屏 / 白屏 / 隐私 / 结束由 React 渲染（结束页要显示品牌 Logo），这里交回覆盖层会重影。
  if (screenMode !== "normal" || offline) {
    overlayRenderer.render(null);
    return;
  }
  overlayRenderer.render({
    screenMode: "normal",
    privacyMessage: machine.project.brand.privacyMessage,
    privacyMasks: (page?.privacyMasks ?? []).map((mask) => ({ id: mask.id, x1: mask.x1, y1: mask.y1, x2: mask.x2, y2: mask.y2, mode: mask.mode })),
    circles: machine.session.circles,
    mask: { title: machine.project.brand.maskTitle, ...(machine.project.brand.maskImageDataUrl ? { imageDataUrl: machine.project.brand.maskImageDataUrl } : {}) }
  });
}

function StageApp() {
  const [state, setState] = useState<BroadcastState | null>(null);
  const portRef = useRef<Browser.runtime.Port | null>(null);
  const toolRef = useRef<string>("none");
  const laserSentAt = useRef(0);
  const [portAttempt, setPortAttempt] = useState(0);

  useEffect(() => {
    const port = browser.runtime.connect({ name: `${PORT_PREFIX}stage` });
    portRef.current = port;
    port.onMessage.addListener((message: BgMessage) => {
      if (message.type === "state") {
        const nextTool = message.state.machine.session.annotationTool;
        if (toolRef.current !== nextTool) annotationLayer?.cancel();
        toolRef.current = nextTool;
        // 标注期间禁止选中页面元素：划动会被浏览器当成拖选文本。
        lockPageSelection(nextTool !== "none");
        setState(message.state);
        renderStageOverlay(message.state);
      }
    });
    port.onDisconnect.addListener(() => {
      if (portRef.current === port) portRef.current = null;
      // 后台 SW 被回收时端口会断开：不重连，页码、画面模式与标注都不再更新。
      setTimeout(() => setPortAttempt((value) => value + 1), 500);
    });
    try {
      port.postMessage({ type: "hello", ctx: "stage" } satisfies UiMessage);
    } catch {
      // 下一次重试会重新连上。
    }
    return () => {
      portRef.current = null;
      try {
        port.disconnect();
      } catch {
        // Already disconnected.
      }
    };
  }, [portAttempt]);

  useEffect(() => {
    const layer = attachAnnotationLayer({
      isCircleTool: () => toolRef.current === "circle",
      isLaserTool: () => toolRef.current === "laser",
      addCircle: (circle) => {
        try {
          portRef.current?.postMessage({
            type: "action",
            action: { type: "add-circle", circle: { id: makeCircleId(), ...circle } }
          } satisfies UiMessage);
        } catch {
          // Reload reconnects.
        }
      },
      // 舞台页不可被捕获，激光点需要转发给观众窗口（约 30Hz）。
      moveLaser: (point) => {
        const now = Date.now();
        if (now - laserSentAt.current < 33) return;
        laserSentAt.current = now;
        try {
          portRef.current?.postMessage({ type: "stage-laser", laser: { x: point.x, y: point.y, expiresAt: now + 1500 } } satisfies UiMessage);
        } catch {
          // Reload reconnects.
        }
      }
    }, overlayRenderer);
    annotationLayer = layer;
    return () => {
      annotationLayer = null;
      layer.detach();
    };
  }, []);

  const machine = state?.machine ?? null;
  const page = machine ? machine.project.pages[machine.session.currentPageIndex] ?? null : null;
  const offlineActive = Boolean(page && machine?.session.offlineFallbackPageId === page.id);
  const grantedOrigins = useMemo(() => {
    if (!machine || !page) return [];
    return machine.session.offlineNetworkGrants.filter((grant) => grant.pageId === page.id).map((grant) => grant.origin);
  }, [machine, page]);

  useEffect(() => {
    document.title = page ? `${page.title} · Showit` : (machine?.project.brand.audienceTitle ?? "Showit 演示画面");
  }, [page, machine?.project.brand.audienceTitle]);

  const screenMode = machine?.session.screenMode ?? "privacy";
  const brand = machine?.project.brand;

  return (
    <main className="stage-root" style={{ "--brand": brand?.primaryColor ?? "#37d0ba" } as React.CSSProperties}>
      {screenMode === "black" ? <div className="stage-cover stage-cover--black" /> : null}
      {screenMode === "white" ? <div className="stage-cover stage-cover--white" /> : null}
      {screenMode === "privacy" ? (
        <div className="stage-cover stage-cover--privacy">
          <span>{brand?.privacyMessage ?? "画面已保护"}</span>
        </div>
      ) : null}
      {screenMode === "ended" ? (
        <div className="stage-cover stage-cover--ended">
          {brand?.logoDataUrl ? <img src={brand.logoDataUrl} alt="" /> : null}
          <h1>{brand?.endTitle ?? "演示结束"}</h1>
          <p>{brand?.endDescription ?? "感谢观看"}</p>
        </div>
      ) : null}

      {screenMode === "normal" && offlineActive && page ? (
        <OfflineFallbackView
          fallback={page.offline}
          label={brand?.offlineLabel ?? "离线备用"}
          executeScripts
          sessionAllowedNetworkOrigins={grantedOrigins}
          onNetworkOriginRequest={(origin) => {
            if (!grantedOrigins.includes(origin)) {
              try {
                portRef.current?.postMessage({ type: "stage-offline-origin-request", origin } satisfies UiMessage);
              } catch {
                // Reconnect happens on next render.
              }
            }
          }}
        />
      ) : null}

      {screenMode === "normal" && !offlineActive && page && (page.pageType === "fixed" || page.pageType === "end" || !page.url) ? (
        <section className="stage-slide">
          {brand?.logoDataUrl ? <img className="stage-slide__logo" src={brand.logoDataUrl} alt="" /> : null}
          <span className="stage-slide__section">{page.section}</span>
          <h1>{page.title}</h1>
          {page.businessLabel ? <span className="stage-slide__label">{page.businessLabel}</span> : null}
          {page.purpose ? <p>{page.purpose}</p> : null}
          <footer style={{ background: brand?.primaryColor ?? "#37d0ba" }} />
        </section>
      ) : null}

      {screenMode === "normal" && !offlineActive && page?.url && (page.pageType === "business" || page.pageType === "external") ? (
        <section className="stage-slide">
          <span className="stage-slide__section">业务页面</span>
          <h1>{page.title}</h1>
          <p>业务页面正在标签页中运行。此画面仅在业务页无法展示时出现。</p>
        </section>
      ) : null}
    </main>
  );
}

const root = document.querySelector("#root");
if (root) createRoot(root).render(<StageApp />);
