import { useEffect, useMemo, useRef, useState } from "react";
import type { PresentationSession } from "@showit/contracts";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import type { BgMessage, BroadcastState, UiMessage } from "@/messaging/protocol";
import { PORT_PREFIX } from "@/messaging/protocol";
import { OfflineFallbackView } from "@/components/OfflineFallbackView";
import { DemoConsole } from "@/lib/demo/DemoConsole";
import { demoViewFromUrl } from "@/lib/demo/views";
import "@/components/ui.css";
import "./audience.css";

function AudienceApp() {
  const viewerId = useMemo(() => new URLSearchParams(window.location.search).get("viewer") ?? `viewer-${Math.random().toString(36).slice(2, 10)}`, []);
  const [state, setState] = useState<BroadcastState | null>(null);
  const [videoLive, setVideoLive] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const laserRef = useRef<HTMLDivElement>(null);
  const laserExpiry = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const port = browser.runtime.connect({ name: `${PORT_PREFIX}audience` });
    const post = (message: UiMessage) => {
      try {
        port.postMessage(message);
      } catch {
        // Background reconnects viewers via the next window open.
      }
    };
    port.onMessage.addListener((message: BgMessage) => {
      if (message.type === "state") setState(message.state);
      if (message.type === "laser") {
        if (laserExpiry.current) clearTimeout(laserExpiry.current);
        const dot = laserRef.current;
        if (dot) {
          if (!message.laser) {
            dot.style.opacity = "0";
          } else {
            dot.style.left = `${message.laser.x * 100}%`;
            dot.style.top = `${message.laser.y * 100}%`;
            dot.style.opacity = "1";
            laserExpiry.current = setTimeout(() => {
              dot.style.opacity = "0";
            }, Math.max(0, message.laser!.expiresAt - Date.now()));
          }
        }
      }
      if (message.type === "rtc-signal" && message.to === viewerId && message.from === "publisher") {
        const data = message.data as { type?: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
        void (async () => {
          let peer = peerRef.current;
          if (!peer) {
            peer = new RTCPeerConnection({ iceServers: [] });
            peerRef.current = peer;
            peer.ontrack = (event) => {
              const video = videoRef.current;
              if (!video) return;
              video.srcObject = event.streams[0] ?? null;
              void video.play().catch(() => undefined);
            };
            peer.onicecandidate = (event) => {
              if (event.candidate) post({ type: "rtc-signal", to: "publisher", from: viewerId, data: { type: "candidate", candidate: event.candidate } });
            };
            peer.onconnectionstatechange = () => {
              const connection = peerRef.current?.connectionState ?? "closed";
              if (connection === "connected") {
                setVideoLive(true);
                post({ type: "viewer-status", viewerId, status: "connected" });
              }
              if (connection === "failed") post({ type: "viewer-status", viewerId, status: "failed" });
            };
          }
          if (data?.type === "offer" && data.sdp) {
            await peer.setRemoteDescription(data.sdp);
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            post({ type: "rtc-signal", to: "publisher", from: viewerId, data: { type: "answer", sdp: peer.localDescription } });
          }
          if (data?.type === "candidate" && data.candidate) await peer.addIceCandidate(data.candidate).catch(() => undefined);
        })();
      }
    });
    post({ type: "hello", ctx: "audience", viewerId });
    return () => {
      peerRef.current?.close();
      peerRef.current = null;
      try {
        port.disconnect();
      } catch {
        // Already disconnected.
      }
    };
  }, [viewerId]);

  const machine = state?.machine ?? null;
  const demoView = machine ? demoViewFromUrl(machine.project.pages[machine.session.currentPageIndex]?.url) : null;
  const page = machine ? machine.project.pages[machine.session.currentPageIndex] ?? null : null;
  const offlineActive = Boolean(page && machine?.session.offlineFallbackPageId === page.id);
  const screenMode = machine?.session.screenMode ?? "privacy";
  const brand = machine?.project.brand;
  const needsVideo = Boolean(machine && page && page.url && !page.url.startsWith("demo://") && (page.pageType === "business" || page.pageType === "external") && !offlineActive && screenMode === "normal");

  useEffect(() => {
    document.title = brand?.audienceTitle ?? "Showit 观众屏";
  }, [brand?.audienceTitle]);

  useEffect(() => {
    if (!needsVideo && videoLive) setVideoLive(false);
  }, [needsVideo, videoLive]);

  const mode: "waiting" | "cover" | "offline" | "slide" | "demo" | "video" | "connecting" = !machine
    ? "waiting"
    : screenMode !== "normal"
      ? "cover"
      : offlineActive
        ? "offline"
        : demoView
          ? "demo"
          : !page?.url || page.pageType === "fixed" || page.pageType === "end"
            ? "slide"
            : videoLive
              ? "video"
              : "connecting";
  const showVideo = mode === "video";
  const circles: PresentationSession["circles"] = machine?.session.circles ?? [];

  return (
    <main className="audience-root" style={{ "--brand": brand?.primaryColor ?? "#37d0ba" } as React.CSSProperties}>
      <video ref={videoRef} className={showVideo ? "audience-video" : "audience-hidden-video"} autoPlay muted playsInline />

      {mode === "waiting" ? (
        <div className="audience-state">
          <h1>{brand?.audienceTitle ?? "Showit 观众屏"}</h1>
          <p>正在等待演示画面…</p>
        </div>
      ) : null}

      {mode === "connecting" ? (
        <div className="audience-state">
          <p>正在连接演示画面…</p>
        </div>
      ) : null}

      {mode === "slide" && page ? (
        <section className="audience-slide">
          {brand?.logoDataUrl ? <img className="audience-slide__logo" src={brand.logoDataUrl} alt="" /> : null}
          <span className="audience-slide__section">{page.section}</span>
          <h1>{page.pageType === "end" ? (brand?.endTitle ?? "演示结束") : page.title}</h1>
          {page.pageType === "end" ? <p>{brand?.endDescription ?? "感谢观看"}</p> : null}
          <footer style={{ background: brand?.primaryColor ?? "#37d0ba" }} />
        </section>
      ) : null}

      {mode === "demo" && demoView ? (
        <div className="audience-demo">
          <DemoConsole mode="mirror" view={demoView} state={state} />
        </div>
      ) : null}

      {mode === "offline" && page ? (
        <OfflineFallbackView fallback={page.offline} label={brand?.offlineLabel ?? "离线备用"} executeScripts={false} />
      ) : null}

      {mode === "cover" ? (
        <div className={`audience-cover audience-cover--${screenMode}`}>
          {screenMode === "ended" ? (
            <>
              {brand?.logoDataUrl ? <img src={brand.logoDataUrl} alt="" /> : null}
              <h1>{brand?.endTitle ?? "演示结束"}</h1>
              <p>{brand?.endDescription ?? "感谢观看"}</p>
            </>
          ) : screenMode === "privacy" ? (
            <span>{brand?.privacyMessage ?? "画面已保护"}</span>
          ) : null}
        </div>
      ) : null}

      {machine && !showVideo ? (
        <div className="audience-annotations" aria-hidden="true">
          {(demoView ? page?.privacyMasks ?? [] : []).map((mask) => (
            <div
              key={mask.id}
              className={`audience-annotation-mask${mask.mode === "blur" ? " is-blur" : ""}`}
              style={{
                left: `${Math.min(mask.x1, mask.x2) * 100}%`,
                top: `${Math.min(mask.y1, mask.y2) * 100}%`,
                width: `${Math.abs(mask.x2 - mask.x1) * 100}%`,
                height: `${Math.abs(mask.y2 - mask.y1) * 100}%`
              }}
            />
          ))}
          {machine.session.circles.map((circle) => (
            <div
              key={circle.id}
              className="audience-annotation-circle"
              style={{
                left: `${Math.min(circle.x1, circle.x2) * 100}%`,
                top: `${Math.min(circle.y1, circle.y2) * 100}%`,
                width: `${Math.abs(circle.x2 - circle.x1) * 100}%`,
                height: `${Math.abs(circle.y2 - circle.y1) * 100}%`
              }}
            />
          ))}
          <div ref={laserRef} className="audience-annotation-laser" />
        </div>
      ) : null}

      {machine ? (
        <footer className="audience-badge">
          <span>{machine.project.name}</span>
          <span>{machine.session.currentPageIndex + 1} / {machine.project.pages.length}</span>
        </footer>
      ) : null}
    </main>
  );
}

const root = document.querySelector("#root");
if (root) createRoot(root).render(<AudienceApp />);
