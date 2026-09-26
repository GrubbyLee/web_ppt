import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useParams } from "react-router-dom";
import type { PresentationPage, PresentationSession, Project } from "@showit/contracts";
import { announceAudienceReady, createAudienceChannel, readSnapshot } from "../../lib/audience-sync";
import { screenModeLabel } from "../../lib/format";
import { AnnotationLayer } from "../presenter/AnnotationLayer";
import { PrivacyMaskLayer } from "../presenter/PrivacyMaskLayer";
import { BusinessPreview } from "../presenter/BusinessPreview";
import { OfflineFallback } from "../../components/OfflineFallback";
import { isOfflineFallbackReady } from "../../lib/offline-fallback";
import { configureReadonlyProxy } from "../../lib/persistence";
import { resolveUrlTemplate } from "../../lib/template";

export type AudienceState = {
  project: Project;
  session: PresentationSession;
};

export function applyAudienceSnapshot(current: AudienceState, snapshot: AudienceState, hasReceivedSnapshot: boolean): AudienceState {
  if (!hasReceivedSnapshot) return snapshot;
  const wasFrozen = current.session.screenMode === "frozen";
  const isFrozen = snapshot.session.screenMode === "frozen";
  if (!wasFrozen && isFrozen) return { ...current, session: { ...current.session, screenMode: "frozen" } };
  if (wasFrozen && isFrozen) return current;
  return snapshot;
}

function AudienceBusinessPage({ project, page }: { project: Project; page: PresentationPage }) {
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const connector = project.connectors.find((candidate) => candidate.id === page.connectorId) ?? project.connectors[0];
  const resolved = page.url ? resolveUrlTemplate(page.url, project, page) : null;
  // BroadcastChannel clones project objects for every session update. Only reload when the
  // actual frame configuration changes, not for timer, annotation, or audience updates.
  const frameSourceKey = JSON.stringify([
    project.id,
    page.id,
    resolved?.ok ? resolved.value : null,
    connector?.id,
    connector?.origin,
    connector?.mode,
    connector?.securityMode,
    connector?.sandboxPermissions,
    connector?.requestHeaders,
    connector?.loginPaths,
    connector?.logoutPaths
  ]);

  useEffect(() => {
    let active = true;
    setFrameUrl(null);
    if (!resolved?.ok || !connector || connector.mode !== "iframe") return;
    const load = connector.securityMode === "readonly-proxy"
      ? configureReadonlyProxy(project.id, connector, resolved.value)
      : Promise.resolve(resolved.value);
    load.then((url) => { if (active) setFrameUrl(url); }).catch(() => undefined);
    return () => { active = false; };
  // frameSourceKey deliberately normalizes the relevant primitive configuration.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameSourceKey]);

  if (!frameUrl) return <BusinessPreview project={project} page={page} />;
  return <iframe className="audience-business-frame" title={page.title} src={frameUrl} sandbox={connector?.sandboxPermissions.join(" ") ?? "allow-scripts allow-same-origin"} referrerPolicy="origin" />;
}

export function AudienceWindow() {
  const params = useParams();
  const sessionId = params.sessionId ?? "";
  const initial = useMemo<AudienceState | null>(() => sessionId ? readSnapshot(sessionId) : null, [sessionId]);
  const [state, setState] = useState<AudienceState | null>(initial);
  const hasReceivedSnapshot = useRef(Boolean(initial));

  useEffect(() => {
    document.title = state?.project.brand.audienceTitle ?? "Showit 观众屏";
    let icon = document.querySelector<HTMLLinkElement>('link[data-showit-favicon="audience"]');
    if (!icon) {
      icon = document.createElement("link");
      icon.rel = "icon";
      icon.dataset.showitFavicon = "audience";
      document.head.append(icon);
    }
    if (state?.project.brand.logoDataUrl) icon.href = state.project.brand.logoDataUrl;
    else icon.removeAttribute("href");
  }, [state?.project.brand.audienceTitle, state?.project.brand.logoDataUrl]);

  useEffect(() => {
    if (!sessionId) return;
    const channel = createAudienceChannel(
      sessionId,
      (snapshot) => setState((current) => {
        const hadSnapshot = hasReceivedSnapshot.current;
        hasReceivedSnapshot.current = true;
        return current ? applyAudienceSnapshot(current, snapshot, hadSnapshot) : snapshot;
      }),
      () => undefined,
      () => setState((current) => current ? { ...current, session: { ...current.session, screenMode: "ended" } } : current)
    );
    announceAudienceReady(channel, initial?.session ?? { id: sessionId, sequence: 0 });
    const stored = readSnapshot(sessionId);
    if (stored) {
      hasReceivedSnapshot.current = true;
      setState(stored);
    }
    return () => channel.close();
  }, [initial, sessionId]);

  if (!state) {
    return <main className="audience-window" aria-label="Showit 观众屏"><section className="audience-cover audience-cover--privacy"><strong>等待演讲者连接</strong><span>此窗口会在演示开始后自动同步画面。</span></section></main>;
  }

  const page = state.project.pages[state.session.currentPageIndex] ?? state.project.pages[0];
  const offlineActive = Boolean(page && state.session.offlineFallbackPageId === page.id && isOfflineFallbackReady(page.offline));

  return (
    <main className="audience-window" aria-label={state.project.brand.audienceTitle} style={{ "--audience-primary": state.project.brand.primaryColor, "--audience-status-background": state.project.brand.statusBackgroundColor } as CSSProperties}>
      {page?.pageType === "end" ? null : offlineActive ? <OfflineFallback fallback={page?.offline} label={state.project.brand.offlineLabel} executeScripts={false} /> : page ? <AudienceBusinessPage project={state.project} page={page} /> : null}
      <AnnotationLayer circles={state.session.circles} laser={state.session.laser} interactive={false} />
      {page ? <PrivacyMaskLayer masks={page.privacyMasks} /> : null}
      {state.session.screenMode === "frozen" ? <aside className="audience-freeze-indicator" role="status">画面已冻结</aside> : state.session.screenMode !== "normal" || page?.pageType === "end" ? (
        <section className={`audience-cover audience-cover--${page?.pageType === "end" ? "ended" : state.session.screenMode}`}>
          <strong>{state.session.screenMode === "ended" || page?.pageType === "end" ? state.project.brand.endTitle : state.session.screenMode === "privacy" ? state.project.brand.privacyMessage : screenModeLabel(state.session.screenMode)}</strong>
          <span>{state.session.screenMode === "ended" || page?.pageType === "end" ? state.project.brand.endDescription : state.session.screenMode === "privacy" ? state.project.brand.loadingMessage : page?.businessLabel ?? "等待演讲者恢复画面"}</span>
        </section>
      ) : null}
      <aside className="audience-status">
        {state.project.brand.logoDataUrl ? <img src={state.project.brand.logoDataUrl} alt="" /> : null}<span>{state.project.name}</span>
        <strong>
          {state.session.currentPageIndex + 1}/{state.project.pages.length}
        </strong>
      </aside>
    </main>
  );
}
