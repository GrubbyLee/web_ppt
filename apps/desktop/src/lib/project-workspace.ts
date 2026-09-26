import { ProjectSchema, type PresentationPage, type PresentationSession, type PresentationStep, type Project } from "@showit/contracts";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { assertZipSafety } from "./zip-safety";
import { argon2id } from "hash-wasm";

export type LegacyProjectPackage = {
  kind: "showit-project";
  packageVersion: 1;
  exportedAt: string;
  project: Project;
};

export type PlainProjectPackage = {
  kind: "showit-project";
  packageVersion: 2;
  exportedAt: string;
  encryption: "none";
  payload: string;
  checksum: string;
};

export type EncryptedProjectPackage = {
  kind: "showit-project";
  packageVersion: 2;
  exportedAt: string;
  encryption: "aes-gcm";
  kdf: "pbkdf2-sha256";
  iterations: number;
  salt: string;
  iv: string;
  payload: string;
  checksum: string;
};

export type ProjectPackage = PlainProjectPackage | EncryptedProjectPackage;

type PackageFile = {
  path: string;
  checksum: string;
};

type PackageManifest = {
  kind: "showit-project";
  packageVersion: 3;
  formatVersion: 1;
  exportedAt: string;
  encryption: "none";
  project: Omit<Project, "pages" | "brand"> & { brand: Omit<Project["brand"], "logoDataUrl">; logoPath?: string };
  files: PackageFile[];
};

type EncryptedPackageManifest = {
  kind: "showit-project";
  packageVersion: 3;
  formatVersion: 1;
  exportedAt: string;
  encryption: "argon2id-aes-256-gcm";
  kdf: { memoryKiB: number; iterations: number; parallelism: number };
  salt: string;
  iv: string;
  payload: PackageFile;
};

type IncomingProjectPackage = {
  kind?: unknown;
  packageVersion?: unknown;
  exportedAt?: unknown;
  project?: unknown;
  encryption?: unknown;
  kdf?: unknown;
  iterations?: unknown;
  salt?: unknown;
  iv?: unknown;
  payload?: unknown;
  checksum?: unknown;
};

export class PackagePasswordError extends Error {
  readonly code: "password-required" | "password-invalid";

  constructor(code: "password-required" | "password-invalid") {
    super(code === "password-required" ? "该项目包已加密，需要输入密码。" : "密码错误或项目包已损坏。");
    this.name = "PackagePasswordError";
    this.code = code;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const argon2Parameters = { memoryKiB: 65_536, iterations: 3, parallelism: 1 };
const maxPackageBytes = 80 * 1024 * 1024;
const maxPackageFiles = 250;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function fingerprintProject(project: Project): Promise<string> {
  return sha256(JSON.stringify(normalizeProject(project)));
}

async function deriveLegacyPackageKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function derivePackageKey(password: string, salt: Uint8Array, parameters = argon2Parameters): Promise<CryptoKey> {
  const material = await argon2id({
    password,
    salt,
    memorySize: parameters.memoryKiB,
    iterations: parameters.iterations,
    parallelism: parameters.parallelism,
    hashLength: 32,
    outputType: "binary"
  });
  try {
    return await crypto.subtle.importKey("raw", material as BufferSource, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally {
    material.fill(0);
  }
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "project";
}

export function createId(prefix: string): string {
  const random = globalThis.crypto?.getRandomValues
    ? (globalThis.crypto.getRandomValues(new Uint32Array(1))[0] ?? 0).toString(36)
    : Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now().toString(36)}-${random}`.slice(0, 120);
}

function blankStep(index: number): PresentationStep {
  return { id: `step-${index + 1}`, kind: "say", text: "说明这一页的关键结论。", execution: "hint", conditionTimeoutSeconds: 8, risk: "normal", autoContinue: false, presenterOnly: false };
}

export function createPage(order: number, connectorId?: string): PresentationPage {
  return {
    id: createId("page"),
    order,
    pageType: "business",
    enabled: true,
    title: `新页面 ${order + 1}`,
    section: "未分组",
    tags: [],
    purpose: "说明本页的演示目的。",
    transitionNote: "",
    errorHandling: "",
    role: "演讲者",
    businessLabel: "待配置业务画面",
    connectorId,
    variables: [],
    estimatedSeconds: 90,
    script: {
      markdown: "## 现场讲述\n\n- 说明关键结论\n- 执行必要操作\n- 确认预期结果",
      steps: [blankStep(0)],
      fallback: "业务页面不可用时，说明备用讲法。"
    },
    privacyMasks: []
  };
}

export function createProject(name: string): Project {
  const id = `${slugify(name)}-${Date.now().toString(36)}`.slice(0, 120);
  const page = createPage(0);
  return {
    id,
    formatVersion: 1,
    name: name.trim() || "未命名演示",
    description: "",
    status: "draft",
    totalPlannedSeconds: page.estimatedSeconds,
    autoAdvanceEnabled: false,
    autoAdvanceSeconds: 90,
    audienceJoinMode: "direct",
    audienceCapacityMode: "p2p-5",
    browserSessionMode: "daily",
    variables: [],
    sensitiveVariables: [],
    brand: {
      primaryColor: "#37d0ba",
      statusBackgroundColor: "#172533",
      privacyMessage: "演示准备中",
      loadingMessage: "正在准备业务画面",
      offlineLabel: "离线备用",
      endTitle: "演示结束",
      endDescription: "感谢观看",
      audienceTitle: "Showit 观众屏"
    },
    layout: { stagePercent: 68, preset: "stage", noteFontScale: 1 },
    connectors: [],
    pages: [page]
  };
}

export function createSession(project: Project): PresentationSession {
  return {
    id: createId("session"),
    projectId: project.id,
    currentPageIndex: 0,
    completedStepIds: [],
    forcedStepCompletions: [],
    timerStatus: "idle",
    totalElapsedMs: 0,
    pageElapsedMs: 0,
    sectionElapsedMs: 0,
    timerStartedAt: null,
    autoAdvanceElapsedMs: 0,
    autoAdvanceStartedAt: null,
    screenMode: "normal",
    offlineFallbackPageId: null,
    offlineNetworkGrants: [],
    pendingHighRiskStepId: null,
    browserSessionMode: project.browserSessionMode,
    annotationTool: "none",
    circles: [],
    laser: null,
    audienceStatus: "disconnected",
    audienceCount: 0,
    sequence: 0
  };
}

export function normalizeProject(project: Project): Project {
  const pages = project.pages.map((page, index) => ({ ...page, order: index }));
  return {
    ...project,
    pages,
    totalPlannedSeconds: Math.max(1, pages.reduce((total, page) => total + page.estimatedSeconds, 0))
  };
}

export function duplicateProject(source: Project): Project {
  const projectId = createId("project");
  const pages = source.pages.map((page, index) => ({
    ...page,
    id: createId("page"),
    order: index,
    script: {
      ...page.script,
      steps: page.script.steps.map((step) => ({ ...step, id: createId("step") }))
    }
  }));
  return normalizeProject({
    ...source,
    id: projectId,
    name: `${source.name} 副本`,
    status: "draft",
    pages
  });
}

type StoredPage = Omit<PresentationPage, "script" | "offline"> & {
  script: Omit<PresentationPage["script"], "markdown"> & { path: string };
  offline?: {
    kind: "image" | "video" | "html";
    path?: string;
    resources?: Array<{ path: string; archivePath: string }>;
    allowedNetworkOrigins?: string[];
  };
};

function dataUrlParts(value: string): { mime: string; bytes: Uint8Array } {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  if (!match?.[1] || !match[2]) throw new Error("嵌入资源格式无效。");
  return { mime: match[1], bytes: base64ToBytes(match[2]) };
}

function extensionForMime(mime: string): string {
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "text/css": "css",
    "text/plain": "txt",
    "application/javascript": "js",
    "application/json": "json",
    "font/woff": "woff",
    "font/woff2": "woff2"
  };
  const extension = extensions[mime];
  if (!extension) throw new Error(`不支持的嵌入资源类型：${mime}`);
  return extension;
}

function mimeForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    mp4: "video/mp4",
    webm: "video/webm",
    css: "text/css",
    txt: "text/plain",
    js: "application/javascript",
    mjs: "application/javascript",
    json: "application/json",
    woff: "font/woff",
    woff2: "font/woff2"
  };
  const mime = extension ? mimeTypes[extension] : undefined;
  if (!mime) throw new Error(`项目包资源扩展名无效：${path}`);
  return mime;
}

function assertSafePackagePath(path: string): void {
  if (!/^[a-zA-Z0-9._/-]+$/.test(path) || path.startsWith("/") || path.includes("//") || path.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error("项目包包含不安全的文件路径。");
  }
}

function unzipPackage(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.byteLength > maxPackageBytes) throw new Error("项目包超过 80 MB 限制。");
  assertZipSafety(bytes, { label: "项目包", maxEntries: maxPackageFiles, maxExpandedBytes: maxPackageBytes });
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("项目包 ZIP 结构无效。");
  }
  const entries = Object.entries(files);
  if (entries.length > maxPackageFiles) throw new Error("项目包文件数量超过限制。");
  let totalBytes = 0;
  for (const [path, content] of entries) {
    assertSafePackagePath(path);
    totalBytes += content.byteLength;
    if (totalBytes > maxPackageBytes) throw new Error("项目包解压后超过 80 MB 限制。");
  }
  return files;
}

async function createPlainArchive(project: Project, exportedAt: string): Promise<Uint8Array> {
  const normalized = normalizeProject(project);
  const files: Record<string, Uint8Array> = {};
  const storedPages: StoredPage[] = [];

  for (const page of normalized.pages) {
    const scriptPath = `scripts/${page.id}.md`;
    files[scriptPath] = strToU8(page.script.markdown);
    let offline: StoredPage["offline"];
    if (page.offline?.kind === "html") {
      const path = page.offline.content ? `offline/${page.id}/index.html` : undefined;
      if (path) files[path] = strToU8(page.offline.content ?? "");
      const resources = (page.offline.resources ?? []).map((resource) => {
        const asset = dataUrlParts(resource.dataUrl);
        const archivePath = `offline/${page.id}/resources/${resource.path}`;
        assertSafePackagePath(archivePath);
        files[archivePath] = asset.bytes;
        return { path: resource.path, archivePath };
      });
      const allowedNetworkOrigins = page.offline.allowedNetworkOrigins ?? [];
      offline = path
        ? { kind: "html", path, ...(resources.length > 0 ? { resources } : {}), ...(allowedNetworkOrigins.length > 0 ? { allowedNetworkOrigins } : {}) }
        : { kind: "html" };
    } else if (page.offline?.dataUrl) {
      const resource = dataUrlParts(page.offline.dataUrl);
      const path = `offline/${page.id}.${extensionForMime(resource.mime)}`;
      files[path] = resource.bytes;
      offline = { kind: page.offline.kind, path };
    } else if (page.offline) {
      offline = { kind: page.offline.kind };
    }
    const { offline: _storedOffline, script: _storedScript, ...pageFields } = page;
    storedPages.push({
      ...pageFields,
      ...(offline ? { offline } : {}),
      script: { steps: page.script.steps, fallback: page.script.fallback, path: scriptPath }
    });
  }

  files["pages.json"] = strToU8(JSON.stringify({ pages: storedPages }, null, 2));
  let logoPath: string | undefined;
  if (normalized.brand.logoDataUrl) {
    const logo = dataUrlParts(normalized.brand.logoDataUrl);
    logoPath = `assets/logo.${extensionForMime(logo.mime)}`;
    files[logoPath] = logo.bytes;
  }

  const { pages: _pages, brand, ...projectFields } = normalized;
  const { logoDataUrl: _logo, ...brandFields } = brand;
  const packageFiles = await Promise.all(Object.entries(files).map(async ([path, content]) => ({ path, checksum: await sha256(content) })));
  const manifest: PackageManifest = {
    kind: "showit-project",
    packageVersion: 3,
    formatVersion: normalized.formatVersion,
    exportedAt,
    encryption: "none",
    project: { ...projectFields, brand: brandFields, ...(logoPath ? { logoPath } : {}) },
    files: packageFiles.sort((left, right) => left.path.localeCompare(right.path))
  };
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  return zipSync(files, { level: 6 });
}

export async function createProjectPackage(project: Project, password?: string): Promise<Uint8Array> {
  const exportedAt = new Date().toISOString();
  const archive = await createPlainArchive(project, exportedAt);
  if (!password) return archive;

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derivePackageKey(password, salt);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, archive as BufferSource));
  const manifest: EncryptedPackageManifest = {
    kind: "showit-project",
    packageVersion: 3,
    formatVersion: 1,
    exportedAt,
    encryption: "argon2id-aes-256-gcm",
    kdf: argon2Parameters,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    payload: { path: "payload.bin", checksum: await sha256(encrypted) }
  };
  return zipSync({ "manifest.json": strToU8(JSON.stringify(manifest, null, 2)), "payload.bin": encrypted }, { level: 0 });
}

function parseProjectCandidate(candidate: unknown): Project {
  const project = ProjectSchema.safeParse(candidate);
  if (!project.success) throw new Error(project.error.issues[0]?.message ?? "项目文件格式无效。");
  return normalizeProject(project.data);
}

async function parseLegacyProjectPackage(text: string, password?: string): Promise<Project> {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") return parseProjectCandidate(parsed);
  const value = parsed as IncomingProjectPackage;
  if (value.kind !== "showit-project") return parseProjectCandidate(parsed);
  if (value.packageVersion === 1) return parseProjectCandidate(value.project);
  if (value.packageVersion !== 2 || typeof value.payload !== "string" || typeof value.checksum !== "string") {
    throw new Error("不支持的项目包版本。");
  }

  if (value.encryption === "none") {
    if (await sha256(value.payload) !== value.checksum) throw new Error("项目包完整性校验失败，文件可能已被修改。");
    return parseProjectCandidate(JSON.parse(value.payload));
  }

  if (value.encryption !== "aes-gcm" || value.kdf !== "pbkdf2-sha256" || typeof value.salt !== "string" || typeof value.iv !== "string") {
    throw new Error("项目包加密参数无效。");
  }
  if (!password) throw new PackagePasswordError("password-required");
  if (typeof value.iterations !== "number" || !Number.isInteger(value.iterations) || value.iterations < 100_000 || value.iterations > 1_000_000) throw new Error("项目包密钥参数无效。");

  // Integrity and parameter checks are password-independent — a mismatch here
  // means a corrupt or tampered file, not a wrong password.
  const encrypted = base64ToBytes(value.payload);
  if (await sha256(encrypted) !== value.checksum) throw new Error("项目包完整性校验失败，文件可能已被修改。");
  const salt = base64ToBytes(value.salt);
  const iv = base64ToBytes(value.iv);
  if (salt.byteLength !== 16 || iv.byteLength !== 12) throw new Error("项目包加密参数无效。");

  let decrypted: ArrayBuffer;
  try {
    const key = await deriveLegacyPackageKey(password, salt, value.iterations);
    decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, encrypted as BufferSource);
  } catch {
    throw new PackagePasswordError("password-invalid");
  }
  try {
    return parseProjectCandidate(JSON.parse(decoder.decode(decrypted)));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("解密后的项目数据格式无效。");
    throw error;
  }
}

function parseManifest(files: Record<string, Uint8Array>): PackageManifest | EncryptedPackageManifest {
  const source = files["manifest.json"];
  if (!source) throw new Error("项目包缺少 manifest.json。");
  let manifest: unknown;
  try {
    manifest = JSON.parse(strFromU8(source));
  } catch {
    throw new Error("项目包清单格式无效。");
  }
  if (!manifest || typeof manifest !== "object") throw new Error("项目包清单格式无效。");
  const value = manifest as Record<string, unknown>;
  if (value.kind !== "showit-project" || value.packageVersion !== 3) throw new Error("不支持的项目包版本。");
  if (value.formatVersion !== 1) throw new Error("该项目包需要更新版本的 Showit。");
  if (value.encryption !== "none" && value.encryption !== "argon2id-aes-256-gcm") throw new Error("项目包加密参数无效。");
  return manifest as PackageManifest | EncryptedPackageManifest;
}

async function parsePlainArchive(files: Record<string, Uint8Array>, manifest: PackageManifest): Promise<Project> {
  if (!manifest.project || !Array.isArray(manifest.files)) throw new Error("项目包清单缺少项目数据。");
  const declaredPaths = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || typeof file.checksum !== "string") throw new Error("项目包文件清单无效。");
    assertSafePackagePath(file.path);
    if (declaredPaths.has(file.path)) throw new Error("项目包文件清单包含重复路径。");
    declaredPaths.add(file.path);
    const content = files[file.path];
    if (!content) throw new Error(`项目包缺少文件：${file.path}`);
    if (await sha256(content) !== file.checksum) throw new Error(`项目包完整性校验失败：${file.path}`);
  }
  for (const path of Object.keys(files)) {
    if (path !== "manifest.json" && !declaredPaths.has(path)) throw new Error(`项目包包含未声明文件：${path}`);
  }

  const pagesFile = files["pages.json"];
  if (!pagesFile) throw new Error("项目包缺少 pages.json。");
  let pageDocument: unknown;
  try {
    pageDocument = JSON.parse(strFromU8(pagesFile));
  } catch {
    throw new Error("pages.json 格式无效。");
  }
  const storedPages = (pageDocument as { pages?: unknown })?.pages;
  if (!Array.isArray(storedPages)) throw new Error("pages.json 缺少页面列表。");

  const pages = storedPages.map((candidate) => {
    if (!candidate || typeof candidate !== "object") throw new Error("项目包页面格式无效。");
    const stored = candidate as StoredPage;
    if (!stored.script || typeof stored.script.path !== "string") throw new Error("项目包页面缺少脚本路径。");
    assertSafePackagePath(stored.script.path);
    const scriptFile = files[stored.script.path];
    if (!scriptFile || !declaredPaths.has(stored.script.path)) throw new Error(`项目包缺少脚本：${stored.script.path}`);
    let offline: PresentationPage["offline"];
    if (stored.offline?.path) {
      assertSafePackagePath(stored.offline.path);
      const offlineFile = files[stored.offline.path];
      if (!offlineFile || !declaredPaths.has(stored.offline.path)) throw new Error(`项目包缺少离线资源：${stored.offline.path}`);
      if (stored.offline.kind === "html") {
        const resources = (stored.offline.resources ?? []).map((resource) => {
          if (!resource || typeof resource.path !== "string" || typeof resource.archivePath !== "string") throw new Error("项目包离线资源清单无效。");
          assertSafePackagePath(resource.path);
          assertSafePackagePath(resource.archivePath);
          const bytes = files[resource.archivePath];
          if (!bytes || !declaredPaths.has(resource.archivePath)) throw new Error(`项目包缺少离线资源：${resource.archivePath}`);
          return { path: resource.path, dataUrl: `data:${mimeForPath(resource.archivePath)};base64,${bytesToBase64(bytes)}` };
        });
        offline = {
          kind: "html",
          content: strFromU8(offlineFile),
          resources,
          allowedNetworkOrigins: Array.isArray(stored.offline.allowedNetworkOrigins) ? stored.offline.allowedNetworkOrigins : []
        };
      } else {
        offline = { kind: stored.offline.kind, dataUrl: `data:${mimeForPath(stored.offline.path)};base64,${bytesToBase64(offlineFile)}` };
      }
    } else if (stored.offline) {
      offline = stored.offline.kind === "html" ? { kind: "html" } : stored.offline.kind === "image" ? { kind: "image" } : { kind: "video" };
    }
    const { path: _path, ...script } = stored.script;
    return { ...stored, offline, script: { ...script, markdown: strFromU8(scriptFile) } };
  });

  const { logoPath, ...projectFields } = manifest.project;
  let logoDataUrl: string | undefined;
  if (logoPath) {
    assertSafePackagePath(logoPath);
    const logo = files[logoPath];
    if (!logo || !declaredPaths.has(logoPath)) throw new Error("项目包缺少品牌 Logo。");
    logoDataUrl = `data:${mimeForPath(logoPath)};base64,${bytesToBase64(logo)}`;
  }
  return parseProjectCandidate({ ...projectFields, brand: { ...projectFields.brand, ...(logoDataUrl ? { logoDataUrl } : {}) }, pages });
}

async function parseZipProjectPackage(bytes: Uint8Array, password?: string): Promise<Project> {
  const files = unzipPackage(bytes);
  const manifest = parseManifest(files);
  if (manifest.encryption === "none") return parsePlainArchive(files, manifest);
  if (!password) throw new PackagePasswordError("password-required");
  const { memoryKiB, iterations, parallelism } = manifest.kdf ?? {};
  // Import caps match the export-side argon2Parameters: packages are authored by
  // Showit itself, so costlier parameters signal a hand-crafted package meant to
  // freeze the main thread during key derivation.
  if (!Number.isInteger(memoryKiB) || memoryKiB < 8_192 || memoryKiB > argon2Parameters.memoryKiB || !Number.isInteger(iterations) || iterations < 1 || iterations > argon2Parameters.iterations || !Number.isInteger(parallelism) || parallelism < 1 || parallelism > 4) {
    throw new Error("项目包 Argon2id 参数无效。");
  }
  const encrypted = files[manifest.payload?.path];
  if (!encrypted || manifest.payload.path !== "payload.bin" || await sha256(encrypted) !== manifest.payload.checksum) throw new Error("项目包完整性校验失败。");
  const salt = base64ToBytes(manifest.salt);
  const iv = base64ToBytes(manifest.iv);
  if (salt.byteLength !== 16 || iv.byteLength !== 12) throw new Error("项目包加密参数无效。");

  let decrypted: Uint8Array;
  try {
    const key = await derivePackageKey(password, salt, { memoryKiB, iterations, parallelism });
    decrypted = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, encrypted as BufferSource));
  } catch {
    // The outer payload checksum was verified above, so decryption can only
    // fail on a wrong password.
    throw new PackagePasswordError("password-invalid");
  }
  const innerFiles = unzipPackage(decrypted);
  const innerManifest = parseManifest(innerFiles);
  if (innerManifest.encryption !== "none") throw new Error("项目包包含嵌套加密数据，格式无效。");
  return await parsePlainArchive(innerFiles, innerManifest);
}

export async function parseProjectPackage(input: string | ArrayBuffer | Uint8Array, password?: string): Promise<Project> {
  if (typeof input === "string") return parseLegacyProjectPackage(input, password);
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const firstNonWhitespace = bytes.find((byte) => ![9, 10, 13, 32].includes(byte));
  if (firstNonWhitespace === 0x7b || firstNonWhitespace === 0x5b) return parseLegacyProjectPackage(decoder.decode(bytes), password);
  return parseZipProjectPackage(bytes, password);
}

export async function downloadProjectPackage(project: Project, password?: string): Promise<void> {
  const content = await createProjectPackage(project, password);
  const url = URL.createObjectURL(new Blob([content as BlobPart], { type: "application/vnd.showit.project+zip" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${slugify(project.name)}.showit`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
