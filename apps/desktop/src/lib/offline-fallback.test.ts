import { describe, expect, it } from "vitest";
import { createOfflineHtmlDataUrl, createOfflineHtmlDocument, isOfflineFallbackReady } from "./offline-fallback";

describe("offline fallback", () => {
  it("only treats populated assets as ready", () => {
    expect(isOfflineFallbackReady({ kind: "image" })).toBe(false);
    expect(isOfflineFallbackReady({ kind: "video", dataUrl: "data:video/mp4;base64,AA==" })).toBe(true);
    expect(isOfflineFallbackReady({ kind: "html", content: "  " })).toBe(false);
    expect(isOfflineFallbackReady({ kind: "html", content: "<h1>备用内容</h1>" })).toBe(true);
  });

  it("wraps offline HTML in a network-isolated document", () => {
    const document = createOfflineHtmlDocument("<script>window.ready = true</script>");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain("base-uri 'none'");
    expect(document).toContain("<script>window.ready = true</script>");
    expect(document).toContain("blocked-origin");
  });

  it("can disable scripts for audience-only rendering", () => {
    const document = createOfflineHtmlDocument("<script>window.ready = true</script>", false);
    expect(document).toContain("script-src 'none'");
  });

  it("creates an opaque data document for presenter-side script execution", () => {
    const url = createOfflineHtmlDataUrl("<h1>备用</h1>");
    expect(url).toMatch(/^data:text\/html;base64,/);
    expect(atob(url.split(",")[1]!)).toContain("script-src 'unsafe-inline'");
  });

  it("embeds package resources and grants only explicit origins", () => {
    const url = createOfflineHtmlDataUrl({
      kind: "html",
      content: '<link rel="stylesheet" href="styles/app.css"><img src="logo.png"><script src="app.js"></script>',
      resources: [
        { path: "styles/app.css", dataUrl: "data:text/css;base64,Ym9keXtiYWNrZ3JvdW5kOnVybCgnLi4vbG9nby5wbmcnKX0=" },
        { path: "logo.png", dataUrl: "data:image/png;base64,AA==" },
        { path: "app.js", dataUrl: "data:application/javascript;base64,d2luZG93LnJlYWR5PXRydWU=" }
      ],
      allowedNetworkOrigins: ["https://api.example.com"]
    });
    const document = atob(url.split(",")[1]!);
    expect(document).toContain("https://api.example.com");
    expect(document).toContain("data:application/javascript;base64");
    expect(document).toContain("data:image/png;base64");
  });

  it("removes scripts for an audience-side static fallback", () => {
    const document = createOfflineHtmlDocument('<main>safe</main><script src="app.js"></script>', false, [{ path: "app.js", dataUrl: "data:application/javascript;base64,eA==" }], []);
    expect(document).not.toContain("<script");
    expect(document).not.toContain("blocked-origin");
    expect(document).toContain("script-src 'none'");
  });
});
