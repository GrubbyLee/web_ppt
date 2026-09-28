import { OfflineFallbackSchema, type OfflineFallback, type OfflinePackageResource } from "@showit/contracts";
import { strFromU8, unzipSync } from "fflate";
import { assertZipSafety } from "./zip-safety";

const maxArchiveBytes = 20 * 1024 * 1024;
const maxExpandedBytes = 32 * 1024 * 1024;
const maxFiles = 65;

const mimeByExtension: Record<string, string> = {
  css: "text/css",
  txt: "text/plain",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  woff: "font/woff",
  woff2: "font/woff2"
};

function safePath(path: string): boolean {
  return /^[a-zA-Z0-9._/-]+$/.test(path)
    && !path.startsWith("/")
    && !path.includes("//")
    && !path.split("/").some((part) => part === "." || part === "..");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function commonRoot(paths: string[]): string {
  const roots = new Set(paths.map((path) => path.split("/")[0]));
  return roots.size === 1 && paths.every((path) => path.includes("/")) ? `${[...roots][0]}/` : "";
}

export function extractExternalNetworkOrigins(content: string): string[] {
  const origins = new Set<string>();
  for (const match of content.matchAll(/https?:\/\/[^\s"'`()<>]+/gi)) {
    try {
      origins.add(new URL(match[0]).origin);
    } catch {
      // Ignore malformed URL-like text; CSP still blocks it at runtime.
    }
  }
  return [...origins].sort();
}

export function requestedOfflineOrigins(fallback: OfflineFallback | undefined): string[] {
  if (fallback?.kind !== "html") return [];
  const content = [fallback.content ?? "", ...(fallback.resources ?? []).filter((resource) => /^(?:data:text\/css|data:application\/javascript)/.test(resource.dataUrl)).map((resource) => {
    try {
      const encoded = resource.dataUrl.slice(resource.dataUrl.indexOf(",") + 1);
      return new TextDecoder().decode(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)));
    } catch {
      return "";
    }
  })].join("\n");
  return extractExternalNetworkOrigins(content);
}

export function parseOfflineHtmlPackage(input: ArrayBuffer | Uint8Array): Extract<OfflineFallback, { kind: "html" }> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > maxArchiveBytes) throw new Error("离线 HTML 压缩包不能超过 20 MB。");
  assertZipSafety(bytes, { label: "离线 HTML 压缩包", maxEntries: maxFiles, maxExpandedBytes });
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes);
  } catch {
    throw new Error("离线 HTML 压缩包不是有效的 ZIP 文件。");
  }
  const entries = Object.entries(archive).filter(([path]) => !path.endsWith("/"));
  if (entries.length === 0 || entries.length > maxFiles) throw new Error("离线 HTML 压缩包文件数量无效。");
  if (entries.some(([path]) => !safePath(path))) throw new Error("离线 HTML 压缩包包含不安全的路径。");
  const root = commonRoot(entries.map(([path]) => path));
  const normalized = entries.map(([path, value]) => [path.slice(root.length), value] as const);
  const indexEntry = normalized.find(([path]) => path.toLowerCase() === "index.html");
  if (!indexEntry) throw new Error("离线 HTML 压缩包根目录必须包含 index.html。");
  let expandedBytes = 0;
  for (const [, value] of normalized) expandedBytes += value.byteLength;
  if (expandedBytes > maxExpandedBytes) throw new Error("离线 HTML 压缩包解压后不能超过 32 MB。");

  const resources: OfflinePackageResource[] = normalized
    .filter(([path]) => path.toLowerCase() !== "index.html")
    .map(([path, value]) => {
      const extension = path.split(".").pop()?.toLowerCase() ?? "";
      const mime = mimeByExtension[extension];
      if (!mime) throw new Error(`离线 HTML 包不支持资源：${path}`);
      return { path, dataUrl: `data:${mime};base64,${bytesToBase64(value)}` };
    });
  const fallback = {
    kind: "html" as const,
    content: strFromU8(indexEntry[1]),
    resources,
    allowedNetworkOrigins: []
  };
  return OfflineFallbackSchema.parse(fallback) as Extract<OfflineFallback, { kind: "html" }>;
}
