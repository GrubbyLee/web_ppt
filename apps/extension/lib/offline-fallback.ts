import type { OfflineFallback, OfflinePackageResource } from "@showit/contracts";

export function isOfflineFallbackReady(fallback: OfflineFallback | undefined): boolean {
  if (!fallback) return false;
  return fallback.kind === "html" ? Boolean(fallback.content?.trim()) : Boolean(fallback.dataUrl);
}

function textFromDataUrl(dataUrl: string): string | null {
  try {
    const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return new TextDecoder().decode(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)));
  } catch {
    return null;
  }
}

function textDataUrl(mime: string, value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function localPath(reference: string, fromPath: string): string | null {
  if (!reference || reference.startsWith("#") || /^(?:data:|blob:|https?:|mailto:|tel:)/i.test(reference)) return null;
  try {
    const base = new URL(fromPath || "index.html", "https://offline.showit.invalid/");
    const resolved = new URL(reference, base);
    if (resolved.origin !== "https://offline.showit.invalid") return null;
    return decodeURIComponent(resolved.pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
}

function rewriteCssUrls(css: string, fromPath: string, resources: Map<string, string>): string {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (source, quote: string, reference: string) => {
    const path = localPath(reference.trim(), fromPath);
    const resource = path ? resources.get(path) : null;
    return resource ? `url(${quote}${resource}${quote})` : source;
  });
}

function bundledResourceUrl(path: string, resources: Map<string, string>): string | null {
  const value = resources.get(path);
  if (!value) return null;
  if (!value.startsWith("data:text/css")) return value;
  const css = textFromDataUrl(value);
  return css === null ? null : textDataUrl("text/css", rewriteCssUrls(css, path, resources));
}

export function createOfflineHtmlDocument(
  content: string,
  executeScripts = true,
  packageResources: OfflinePackageResource[] = [],
  allowedNetworkOrigins: string[] = []
): string {
  const allowed = executeScripts ? allowedNetworkOrigins.join(" ") : "";
  const networkPolicy = allowed || "'none'";
  const networkSources = allowed ? ` ${allowed}` : "";
  const policy = [
    "default-src 'none'",
    "base-uri 'none'",
    `connect-src ${networkPolicy}`,
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    `img-src data: blob:${networkSources}`,
    `media-src data: blob:${networkSources}`,
    `font-src data:${networkSources}`,
    `style-src 'unsafe-inline' data:${networkSources}`,
    `script-src ${executeScripts ? `'unsafe-inline' data:${networkSources}` : "'none'"}`
  ].join("; ");

  if (typeof DOMParser === "undefined") {
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"></head><body>${content}</body></html>`;
  }
  const document = new DOMParser().parseFromString(content, "text/html");
  document.querySelectorAll("base").forEach((element) => element.remove());
  if (!executeScripts) document.querySelectorAll("script").forEach((element) => element.remove());
  const resources = new Map(packageResources.map((resource) => [resource.path, resource.dataUrl]));
  const rewriteAttribute = (element: Element, attribute: string) => {
    const reference = element.getAttribute(attribute);
    if (!reference) return;
    const path = localPath(reference, "index.html");
    const resource = path ? bundledResourceUrl(path, resources) : null;
    if (resource) element.setAttribute(attribute, resource);
  };
  document.querySelectorAll("[src]").forEach((element) => rewriteAttribute(element, "src"));
  document.querySelectorAll("link[href]").forEach((element) => rewriteAttribute(element, "href"));
  document.querySelectorAll("[poster]").forEach((element) => rewriteAttribute(element, "poster"));
  document.querySelectorAll<HTMLElement>("[style]").forEach((element) => element.setAttribute("style", rewriteCssUrls(element.getAttribute("style") ?? "", "index.html", resources)));
  document.querySelectorAll("style").forEach((element) => { element.textContent = rewriteCssUrls(element.textContent ?? "", "index.html", resources); });
  const meta = document.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = policy;
  document.head.prepend(meta);
  const charset = document.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  document.head.prepend(charset);
  if (executeScripts) {
    const reporter = document.createElement("script");
    reporter.textContent = "document.addEventListener('securitypolicyviolation',function(event){try{var url=new URL(event.blockedURI);if(url.protocol==='http:'||url.protocol==='https:')parent.postMessage({__showitOffline:1,type:'blocked-origin',origin:url.origin},'*')}catch(_error){}})";
    meta.after(reporter);
  }
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

export function createOfflineHtmlDataUrl(fallback: string | Extract<OfflineFallback, { kind: "html" }>): string {
  const html = typeof fallback === "string"
    ? createOfflineHtmlDocument(fallback, true)
    : createOfflineHtmlDocument(fallback.content ?? "", true, fallback.resources ?? [], fallback.allowedNetworkOrigins ?? []);
  return textDataUrl("text/html", html);
}
