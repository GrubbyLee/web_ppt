import type { OfflineFallback, PresentationSession, Project } from "@showit/contracts";

type AudienceOfflineFallback =
  | { kind: "image"; dataUrl?: string }
  | { kind: "video"; dataUrl?: string }
  | { kind: "html"; content?: string };

export type RemoteAudienceSnapshot = {
  project: {
    audienceJoinMode: Project["audienceJoinMode"];
    audienceCapacityMode: Project["audienceCapacityMode"];
    brand: Project["brand"];
  };
  page: null | {
    title: string;
    businessLabel: string;
    privacyMasks: Array<Pick<Project["pages"][number]["privacyMasks"][number], "x1" | "y1" | "x2" | "y2" | "mode">>;
    offline?: AudienceOfflineFallback;
  };
  session: {
    currentPageIndex: number;
    pageCount: number;
    screenMode: PresentationSession["screenMode"];
    circles: Array<Pick<PresentationSession["circles"][number], "x1" | "y1" | "x2" | "y2">>;
    laser: null | Pick<NonNullable<PresentationSession["laser"]>, "x" | "y" | "expiresAt">;
  };
};

function projectOfflineFallback(fallback: OfflineFallback): AudienceOfflineFallback {
  if (fallback.kind === "html") return { kind: "html", ...(fallback.content === undefined ? {} : { content: fallback.content }) };
  return { kind: fallback.kind, ...(fallback.dataUrl === undefined ? {} : { dataUrl: fallback.dataUrl }) };
}

export function createRemoteAudienceSnapshot(project: Project, session: PresentationSession): RemoteAudienceSnapshot {
  const page = project.pages[session.currentPageIndex] ?? null;
  const offlineActive = page !== null && session.offlineFallbackPageId === page.id && page.offline !== undefined;
  return {
    project: {
      audienceJoinMode: project.audienceJoinMode,
      audienceCapacityMode: project.audienceCapacityMode,
      brand: { ...project.brand }
    },
    page: page === null ? null : {
      title: page.title,
      businessLabel: page.businessLabel,
      privacyMasks: page.privacyMasks.map(({ x1, y1, x2, y2, mode }) => ({ x1, y1, x2, y2, mode })),
      ...(offlineActive ? { offline: projectOfflineFallback(page.offline!) } : {})
    },
    session: {
      currentPageIndex: session.currentPageIndex,
      pageCount: project.pages.length,
      screenMode: session.screenMode,
      circles: session.circles.map(({ x1, y1, x2, y2 }) => ({ x1, y1, x2, y2 })),
      laser: session.laser === null ? null : { x: session.laser.x, y: session.laser.y, expiresAt: session.laser.expiresAt }
    }
  };
}
