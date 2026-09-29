import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import type { BgMessage, BroadcastState, UiMessage } from "@/messaging/protocol";
import { PORT_PREFIX } from "@/messaging/protocol";
import { OfflineFallbackView } from "@/components/OfflineFallbackView";
import "@/components/ui.css";
import "./stage.css";

function StageApp() {
  const [state, setState] = useState<BroadcastState | null>(null);
  const laserRef = useRef<HTMLDivElement>(null);
  const laserExpiry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const portRef = useRef<Browser.runtime.Port | null>(null);
  const circleDraft = useRef<{ startX: number; startY: number; element: HTMLDivElement } | null>(null);
  const toolRef = useRef<string>("none");

  useEffect(() => {
    const port = browser.runtime.connect({ name: `${PORT_PREFIX}stage` });
    portRef.current = port;
    port.onMessage.addListener((message: BgMessage) => {
      if (message.type === "state") {
        toolRef.current = message.state.machine.session.annotationTool;
        setState(message.state);
      }
    });
    try {
      port.postMessage({ type: "hello", ctx: "stage" } satisfies UiMessage);
    } catch {
      // Port closed; reload reconnects.
    }
    return () => {
      portRef.current = null;
      try {
        port.disconnect();
      } catch {
        // Already disconnected.
      }
    };
  }, []);

  const laserSentAt = useRef(0);

  const onPointerMove = (event: React.PointerEvent) => {
    if (toolRef.current !== "laser" || event.pointerType !== "mouse") return;
    const dot = laserRef.current;
    if (!dot) return;
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const x = Math.max(0, Math.min(1, event.clientX / width));
    const y = Math.max(0, Math.min(1, event.clientY / height));
    dot.style.left = `${x * 100}%`;
    dot.style.top = `${y * 100}%`;
    dot.style.opacity = "1";
    if (laserExpiry.current) clearTimeout(laserExpiry.current);
    laserExpiry.current = setTimeout(() => {
      dot.style.opacity = "0";
    }, 1500);
    // Relay to the audience windows at ~30Hz; business-page pointers travel
    // inside the captured video, stage pages are not capturable.
    const now = Date.now();
    if (now - laserSentAt.current >= 33) {
      laserSentAt.current = now;
      try {
        portRef.current?.postMessage({ type: "stage-laser", laser: { x, y, expiresAt: now + 1500 } } satisfies UiMessage);
      } catch {
        // Reload reconnects.
      }
    }
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (toolRef.current !== "circle" || event.button !== 0) return;
    const host = document.querySelector(".stage-annotations");
    if (!host || (event.target instanceof HTMLElement && event.target.closest(".stage-annotation-draft"))) return;
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const x = Math.max(0, Math.min(1, event.clientX / width));
    const y = Math.max(0, Math.min(1, event.clientY / height));
    const box = document.createElement("div");
    box.className = "stage-annotation-circle stage-annotation-draft";
    box.style.left = `${x * 100}%`;
    box.style.top = `${y * 100}%`;
    box.style.width = "0%";
    box.style.height = "0%";
    host.append(box);
    circleDraft.current = { startX: x, startY: y, element: box };
  };

  const onPointerMoveCircle = (event: React.PointerEvent) => {
    const draft = circleDraft.current;
    if (!draft) return;
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const x = Math.max(0, Math.min(1, event.clientX / width));
    const y = Math.max(0, Math.min(1, event.clientY / height));
    draft.element.style.left = `${Math.min(draft.startX, x) * 100}%`;
    draft.element.style.top = `${Math.min(draft.startY, y) * 100}%`;
    draft.element.style.width = `${Math.abs(x - draft.startX) * 100}%`;
    draft.element.style.height = `${Math.abs(y - draft.startY) * 100}%`;
  };

  const onPointerUp = () => {
    const draft = circleDraft.current;
    if (!draft) return;
    circleDraft.current = null;
    const left = Number(draft.element.style.left!.slice(0, -1)) / 100;
    const top = Number(draft.element.style.top!.slice(0, -1)) / 100;
    const width = Number(draft.element.style.width!.slice(0, -1)) / 100;
    const height = Number(draft.element.style.height!.slice(0, -1)) / 100;
    draft.element.remove();
    if (width < 0.01 || height < 0.01) return;
    try {
      portRef.current?.postMessage({
        type: "action",
        action: {
          type: "add-circle",
          circle: {
            id: `circle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            x1: left,
            y1: top,
            x2: left + width,
            y2: top + height
          }
        }
      } satisfies UiMessage);
    } catch {
      // Reload reconnects.
    }
  };

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
    <main className="stage-root" style={{ "--brand": brand?.primaryColor ?? "#37d0ba" } as React.CSSProperties} onPointerMove={(event) => { onPointerMove(event); onPointerMoveCircle(event); }} onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
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

      {machine && screenMode === "normal" && !offlineActive ? (
        <div className="stage-annotations" aria-hidden="true">
          {machine.session.circles.map((circle) => (
            <div
              key={circle.id}
              className="stage-annotation-circle"
              style={{
                left: `${Math.min(circle.x1, circle.x2) * 100}%`,
                top: `${Math.min(circle.y1, circle.y2) * 100}%`,
                width: `${Math.abs(circle.x2 - circle.x1) * 100}%`,
                height: `${Math.abs(circle.y2 - circle.y1) * 100}%`
              }}
            />
          ))}
          <div ref={laserRef} className="stage-annotation-laser" />
        </div>
      ) : null}
    </main>
  );
}

const root = document.querySelector("#root");
if (root) createRoot(root).render(<StageApp />);
