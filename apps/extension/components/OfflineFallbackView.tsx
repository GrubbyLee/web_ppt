import { useEffect, useRef } from "react";
import type { OfflineFallback as OfflineFallbackAsset } from "@showit/contracts";
import { createOfflineHtmlDataUrl, createOfflineHtmlDocument, isOfflineFallbackReady } from "@/lib/offline-fallback";

type OfflineFallbackProps = {
  fallback: OfflineFallbackAsset | undefined;
  label: string;
  executeScripts?: boolean;
  sessionAllowedNetworkOrigins?: string[];
  onNetworkOriginRequest?: (origin: string) => void;
};

export function OfflineFallbackView({ fallback, label, executeScripts = true, sessionAllowedNetworkOrigins = [], onNetworkOriginRequest }: OfflineFallbackProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!executeScripts || !onNetworkOriginRequest) return;
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      const message = event.data as { __showitOffline?: unknown; type?: unknown; origin?: unknown } | null;
      if (message?.__showitOffline !== 1 || message.type !== "blocked-origin" || typeof message.origin !== "string") return;
      try {
        const url = new URL(message.origin);
        if ((url.protocol === "https:" || url.protocol === "http:") && url.origin === message.origin) onNetworkOriginRequest(url.origin);
      } catch {
        // Ignore malformed origins from isolated content.
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [executeScripts, onNetworkOriginRequest]);
  if (!isOfflineFallbackReady(fallback)) return null;
  return (
    <div className="offline-fallback" aria-label={label}>
      {fallback?.kind === "image" ? <img src={fallback.dataUrl} alt={label} /> : null}
      {fallback?.kind === "video" ? <video src={fallback.dataUrl} controls autoPlay muted playsInline /> : null}
      {fallback?.kind === "html" ? <iframe ref={frame} title={label} {...(executeScripts ? { src: createOfflineHtmlDataUrl({ ...fallback, allowedNetworkOrigins: [...new Set([...(fallback.allowedNetworkOrigins ?? []), ...sessionAllowedNetworkOrigins])] }) } : { srcDoc: createOfflineHtmlDocument(fallback.content ?? "", false, fallback.resources ?? [], []) })} sandbox={executeScripts ? "allow-scripts" : ""} referrerPolicy="no-referrer" /> : null}
      <span>{label}</span>
    </div>
  );
}
