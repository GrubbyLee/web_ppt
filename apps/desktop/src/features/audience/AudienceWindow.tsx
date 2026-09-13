import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useParams } from "react-router-dom";
import type { PresentationSession, Project } from "@showit/contracts";
import { announceAudienceReady, createAudienceChannel, readSnapshot } from "../../lib/audience-sync";
import { sampleProject, sampleSession } from "../../lib/sample-project";
import { screenModeLabel } from "../../lib/format";
import { AnnotationLayer } from "../presenter/AnnotationLayer";
import { PrivacyMaskLayer } from "../presenter/PrivacyMaskLayer";
import { BusinessPreview } from "../presenter/BusinessPreview";
import { OfflineFallback } from "../../components/OfflineFallback";
import { isOfflineFallbackReady } from "../../lib/offline-fallback";

type AudienceState = {
  project: Project;
  session: PresentationSession;
};

export function AudienceWindow() {
  const params = useParams();
  const sessionId = params.sessionId ?? sampleSession.id;
  const initial = useMemo<AudienceState>(() => readSnapshot(sessionId) ?? { project: sampleProject, session: { ...sampleSession, id: sessionId } }, [sessionId]);
  const [state, setState] = useState<AudienceState>(initial);
  const page = state.project.pages[state.session.currentPageIndex] ?? state.project.pages[0];
  const offlineActive = Boolean(page && state.session.offlineFallbackPageId === page.id && isOfflineFallbackReady(page.offline));

  useEffect(() => {
    document.title = state.project.brand.audienceTitle;
    let icon = document.querySelector<HTMLLinkElement>('link[data-showit-favicon="audience"]');
    if (!icon) {
      icon = document.createElement("link");
      icon.rel = "icon";
      icon.dataset.showitFavicon = "audience";
      document.head.append(icon);
    }
    if (state.project.brand.logoDataUrl) icon.href = state.project.brand.logoDataUrl;
    else icon.removeAttribute("href");
  }, [state.project.brand.audienceTitle, state.project.brand.logoDataUrl]);

  useEffect(() => {
    const channel = createAudienceChannel(
      sessionId,
      (snapshot) => setState(snapshot),
      () => undefined,
      () => setState((current) => ({ ...current, session: { ...current.session, screenMode: "ended" } }))
    );
    announceAudienceReady(channel, initial.session);
    const stored = readSnapshot(sessionId);
    if (stored) setState(stored);
    return () => channel.close();
  }, [initial.session, sessionId]);

  return (
    <main className="audience-window" aria-label={state.project.brand.audienceTitle} style={{ "--audience-primary": state.project.brand.primaryColor, "--audience-status-background": state.project.brand.statusBackgroundColor } as CSSProperties}>
      {page?.pageType === "end" ? null : offlineActive ? <OfflineFallback fallback={page?.offline} label={state.project.brand.offlineLabel} executeScripts={false} /> : page ? <BusinessPreview page={page} /> : null}
      <AnnotationLayer circles={state.session.circles} laser={state.session.laser} interactive={false} />
      {page ? <PrivacyMaskLayer masks={page.privacyMasks} /> : null}
      {state.session.screenMode !== "normal" || page?.pageType === "end" ? (
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
