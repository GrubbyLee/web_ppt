import { z } from "zod";

const sensitiveNamePattern = /(password|passwd|secret|token|cookie|authorization|credential|api[-_]?key)/i;

const identifier = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "标识符只能使用字母、数字、点、下划线和连字符");
const variableKey = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "变量名必须以字母开头，只能使用字母、数字、下划线和连字符")
  .refine((value) => !sensitiveNamePattern.test(value), "变量名不能表示密码、Token、Cookie 或密钥");
const runtimeSecretKey = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "敏感变量名必须以字母开头，只能使用字母、数字、下划线和连字符");

function isAllowedBusinessUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password) return false;
    if ([...url.searchParams.keys()].some((key) => sensitiveNamePattern.test(key))) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && localHost);
  } catch {
    return false;
  }
}

const businessUrl = z
  .string()
  .url("请输入完整的 HTTP(S) URL。")
  .refine(isAllowedBusinessUrl, "只允许 HTTPS，或 localhost/127.0.0.1 的 HTTP 地址，且不能包含凭据或敏感查询参数。");

function isAllowedBusinessUrlTemplate(value: string): boolean {
  if (!value.includes("{{")) return isAllowedBusinessUrl(value);
  const protocolIndex = value.indexOf("://");
  if (protocolIndex < 0) return false;
  const authorityStart = protocolIndex + 3;
  const authorityEnd = ["/", "?", "#"]
    .map((delimiter) => value.indexOf(delimiter, authorityStart))
    .filter((index) => index >= 0)
    .reduce((minimum, index) => Math.min(minimum, index), value.length);
  if (value.slice(0, authorityEnd).includes("{{")) return false;
  const replaced = value.replace(/{{\s*(?:project|page)\.[a-zA-Z][a-zA-Z0-9_-]*\s*}}|{{\s*(?:role|page\.id|page\.title)\s*}}/g, "showit-value");
  if (replaced.includes("{{") || replaced.includes("}}")) return false;
  return isAllowedBusinessUrl(replaced);
}

const businessUrlTemplate = z
  .string()
  .min(1)
  .max(4_000)
  .refine(isAllowedBusinessUrlTemplate, "URL 模板必须使用 HTTPS 或本机开发 Origin，不能包含凭据或敏感查询参数，变量只能出现在路径、查询或 Hash 中。");

function isAllowedConnectorPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[?#]/.test(value)) return false;
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.includes("\\") || decoded.startsWith("//")) return false;
    return !decoded.split("/").some((segment) => segment === "." || segment === "..");
  } catch {
    return false;
  }
}

const connectorPath = z
  .string()
  .min(1)
  .max(500)
  .refine(isAllowedConnectorPath, "放行路径必须是以单个 / 开头且不含查询、Hash 或路径穿越的绝对路径。");

const sessionProbeField = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "会话字段名只能使用字母、数字和下划线。");

const ConnectorSessionProbeSchema = z.object({
  path: connectorPath,
  userPath: z.array(sessionProbeField).min(1).max(6).default(["data", "user"]),
  primaryRoleField: sessionProbeField.default("role"),
  rolesField: sessionProbeField.default("roles"),
  roleMappings: z.array(z.object({
    presentationRole: z.string().trim().min(1).max(80),
    connectorRole: z.string().trim().min(1).max(80)
  }).strict()).max(30).default([])
}).strict();

const connectorHeaderName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "Header 名称无效")
  .refine((value) => !sensitiveNamePattern.test(value), "连接器不能保存认证或密钥 Header")
  .refine((value) => {
    const name = value.toLowerCase();
    return ![
      "host", "connection", "content-length", "transfer-encoding", "content-encoding",
      "keep-alive", "upgrade", "proxy-authorization", "proxy-authenticate", "te", "trailer",
      "origin", "referer", "accept-encoding", "forwarded"
    ].includes(name) && !name.startsWith("x-forwarded-") && !name.startsWith("sec-");
  }, "连接器 Header 不能覆盖代理控制字段");

export const ConnectorRequestHeaderSchema = z.object({
  name: connectorHeaderName,
  value: z.string().max(500).refine((value) => !/[\r\n]/.test(value), "Header 值不能包含换行")
}).strict();

export const PresentationVariableSchema = z.object({
  key: variableKey,
  value: z.string().max(2_000),
  description: z.string().max(200).optional()
});

// This contract intentionally has no value field. Secret values only exist in
// the presenter process memory and must never enter a project or package.
export const SensitiveRuntimeVariableSchema = z.object({
  key: runtimeSecretKey,
  label: z.string().min(1).max(120),
  description: z.string().max(200).optional(),
  required: z.boolean().default(true),
  expiresAfterMinutes: z.number().int().min(1).max(360).default(60)
}).strict();

export const ProjectStatusSchema = z.enum(["draft", "published", "archived"]);
export const ConnectorModeSchema = z.enum(["extension", "iframe", "window"]);
export const PermissionModeSchema = z.enum(["observe", "assist", "automate"]);
export const ConnectorSecurityModeSchema = z.enum(["interactive", "request-protection", "readonly-proxy"]);
export const StepKindSchema = z.enum(["say", "act", "expect", "transition"]);
export const StepExecutionSchema = z.enum(["hint", "highlight", "assist", "auto"]);
export const PageTypeSchema = z.enum(["fixed", "business", "external", "end"]);
export const ScreenModeSchema = z.enum(["normal", "black", "white", "frozen", "privacy", "ended"]);
export const TimerStatusSchema = z.enum(["idle", "running", "paused"]);
export const AudienceStatusSchema = z.enum(["disconnected", "connecting", "synced"]);
export const AudienceJoinModeSchema = z.enum(["direct", "approval"]);
export const BrowserSessionModeSchema = z.enum(["daily", "dedicated"]);

export const CircleSchema = z.object({
  id: identifier,
  x1: z.number().min(0).max(1),
  y1: z.number().min(0).max(1),
  x2: z.number().min(0).max(1),
  y2: z.number().min(0).max(1)
});

const locatorValue = z.string().min(1).max(200).refine((value) => !/(password|passwd|secret|token|cookie|authorization|credential|api[-_]?key)/i.test(value), "定位器不能引用敏感字段");
export const ElementLocatorSchema = z.object({
  strategy: z.enum(["testid", "id", "aria", "role"]),
  value: locatorValue
}).strict();

const inputLocatorValue = z.string().min(1).max(200);
export const InputElementLocatorSchema = z.object({
  strategy: z.enum(["testid", "id", "aria", "role"]),
  value: inputLocatorValue
}).strict();

export const InputValueSourceSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("fixed"), value: z.string().max(2_000) }).strict(),
  z.object({ source: z.literal("project"), key: variableKey }).strict(),
  z.object({ source: z.literal("page"), key: variableKey }).strict(),
  z.object({ source: z.literal("sensitive"), key: runtimeSecretKey }).strict()
]);

export const PrivacyMaskSchema = z.object({
  id: identifier,
  x1: z.number().min(0).max(1),
  y1: z.number().min(0).max(1),
  x2: z.number().min(0).max(1),
  y2: z.number().min(0).max(1),
  mode: z.enum(["solid", "blur"]).default("solid"),
  locator: ElementLocatorSchema.optional()
});

export const LaserPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  expiresAt: z.number().int().positive()
});

export const RecordedActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), locator: ElementLocatorSchema, label: z.string().max(160).optional() }).strict(),
  z.object({ type: z.literal("focus"), locator: ElementLocatorSchema, label: z.string().max(160).optional() }).strict(),
  z.object({ type: z.literal("scroll"), x: z.number().int().min(0).max(10_000_000), y: z.number().int().min(0).max(10_000_000) }).strict(),
  z.object({ type: z.literal("navigate"), url: businessUrl }).strict(),
  z.object({ type: z.literal("fill"), locator: InputElementLocatorSchema, input: InputValueSourceSchema, label: z.string().max(160).optional() }).strict()
]);

export const ExpectedConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url"), value: businessUrl }).strict(),
  z.object({ type: z.literal("title"), value: z.string().min(1).max(300) }).strict(),
  z.object({ type: z.literal("element"), locator: ElementLocatorSchema }).strict(),
  z.object({ type: z.literal("text"), value: z.string().min(1).max(300) }).strict()
]);

export const PresentationStepSchema = z.object({
  id: identifier,
  kind: StepKindSchema,
  text: z.string().min(1).max(4_000),
  action: z.string().max(4_000).optional(),
  expected: z.string().max(4_000).optional(),
  execution: StepExecutionSchema.default("hint"),
  recordedAction: RecordedActionSchema.optional(),
  expectedCondition: ExpectedConditionSchema.optional(),
  conditionTimeoutSeconds: z.number().int().min(1).max(30).default(8),
  risk: z.enum(["normal", "high"]).default("normal"),
  autoContinue: z.boolean().default(false),
  presenterOnly: z.boolean().optional()
});

export const ScriptSchema = z.object({
  markdown: z.string().max(50_000),
  steps: z.array(PresentationStepSchema).max(100),
  fallback: z.string().max(4_000).optional()
});

const imageDataUrl = z.string().max(16_000_000).regex(/^data:image\/(?:png|jpeg|webp);base64,/, "离线图片必须是 PNG、JPEG 或 WebP Data URL。");
const videoDataUrl = z.string().max(64_000_000).regex(/^data:video\/(?:mp4|webm);base64,/, "离线视频必须是 MP4 或 WebM Data URL。");
const offlineResourcePath = z.string().min(1).max(240).regex(/^[a-zA-Z0-9._/-]+$/).refine(
  (value) => !value.startsWith("/") && !value.includes("//") && !value.split("/").some((part) => part === "." || part === ".."),
  "离线资源路径不安全。"
);
const offlineResourceDataUrl = z.string().max(16_000_000).regex(
  /^data:(?:text\/css|text\/plain|application\/(?:javascript|json)|image\/(?:png|jpeg|webp|gif)|font\/woff2?);base64,/,
  "离线包资源类型不受支持。"
);
const explicitNetworkOrigin = z.string().max(300).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && value === url.origin && !url.username && !url.password;
  } catch {
    return false;
  }
}, "外部网络权限必须是明确的 HTTP(S) Origin。");

export const OfflinePackageResourceSchema = z.object({
  path: offlineResourcePath,
  dataUrl: offlineResourceDataUrl
}).strict();

export const OfflineFallbackSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image"), dataUrl: imageDataUrl.optional() }),
  z.object({ kind: z.literal("video"), dataUrl: videoDataUrl.optional() }),
  z.object({
    kind: z.literal("html"),
    content: z.string().max(1_000_000).optional(),
    resources: z.array(OfflinePackageResourceSchema).max(64).optional(),
    allowedNetworkOrigins: z.array(explicitNetworkOrigin).max(20).optional()
  }).superRefine((value, context) => {
    const paths = new Set<string>();
    let totalLength = value.content?.length ?? 0;
    for (const resource of value.resources ?? []) {
      if (paths.has(resource.path)) context.addIssue({ code: "custom", path: ["resources"], message: `离线资源路径重复：${resource.path}` });
      paths.add(resource.path);
      totalLength += resource.dataUrl.length;
    }
    if (totalLength > 32_000_000) context.addIssue({ code: "custom", message: "离线 HTML 包不能超过 32 MB。" });
  })
]);

export const PresentationPageSchema = z.object({
  id: identifier,
  order: z.number().int().nonnegative(),
  pageType: PageTypeSchema.default("business"),
  enabled: z.boolean().default(true),
  title: z.string().min(1).max(160),
  section: z.string().min(1).max(80),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  purpose: z.string().min(1).max(500),
  transitionNote: z.string().max(1_000).default(""),
  errorHandling: z.string().max(2_000).default(""),
  role: z.string().min(1).max(80),
  businessLabel: z.string().min(1).max(160),
  url: businessUrlTemplate.optional(),
  fallbackUrl: businessUrlTemplate.optional(),
  offline: OfflineFallbackSchema.optional(),
  privacyMasks: z.array(PrivacyMaskSchema).max(30).default([]),
  variables: z.array(PresentationVariableSchema).max(50).default([]),
  connectorId: identifier.optional(),
  estimatedSeconds: z.number().int().positive().max(14_400),
  autoAdvanceSeconds: z.number().int().positive().max(14_400).optional(),
  script: ScriptSchema
});

export const PresentationConnectorSchema = z.object({
  id: identifier,
  name: z.string().min(1).max(120),
  origin: businessUrl,
  mode: ConnectorModeSchema,
  permission: PermissionModeSchema.default("assist"),
  securityMode: ConnectorSecurityModeSchema.default("interactive"),
  environment: z.string().trim().min(1).max(80).default("默认环境"),
  requestHeaders: z.array(ConnectorRequestHeaderSchema).max(20).default([]),
  basicAuthInstructions: z.string().max(1_000).default(""),
  loginPaths: z.array(connectorPath).max(20).default([]),
  logoutPaths: z.array(connectorPath).max(20).default([]),
  roleSwitchPaths: z.array(connectorPath).max(20).default([]),
  sessionProbe: ConnectorSessionProbeSchema.optional(),
  sandboxPermissions: z.array(z.enum(["allow-scripts", "allow-same-origin", "allow-forms"])).max(3),
  allowedOrigins: z.array(businessUrl).min(1).max(20)
});

export const ProjectLayoutSchema = z.object({
  // 5:4 stage-to-notes default; adjustment is clamped to [1:1, 2:1] (50–66%).
  // Upper bound stays tolerant so projects saved by older builds keep parsing.
  stagePercent: z.number().int().min(50).max(75).default(56),
  preset: z.enum(["stage", "balanced", "notes"]).default("stage"),
  noteFontScale: z.number().min(0.85).max(1.35).default(1)
});

const brandColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "品牌颜色必须使用六位十六进制格式。");

export const ProjectBrandSchema = z.object({
  primaryColor: brandColor.default("#37d0ba"),
  statusBackgroundColor: brandColor.default("#172533"),
  privacyMessage: z.string().min(1).max(120).default("演示准备中"),
  loadingMessage: z.string().min(1).max(120).default("正在准备业务画面"),
  offlineLabel: z.string().min(1).max(40).default("离线备用"),
  endTitle: z.string().min(1).max(120).default("演示结束"),
  endDescription: z.string().max(240).default("感谢观看"),
  audienceTitle: z.string().min(1).max(120).default("Showit 观众屏"),
  logoDataUrl: z.string().max(1_500_000).regex(/^data:image\/(?:png|jpeg|webp);base64,/).optional()
});

export const ProjectSchema = z.object({
  id: identifier,
  formatVersion: z.literal(1),
  name: z.string().min(1).max(120),
  description: z.string().max(1_000),
  status: ProjectStatusSchema,
  totalPlannedSeconds: z.number().int().positive().max(86_400),
  autoAdvanceEnabled: z.boolean().default(false),
  autoAdvanceSeconds: z.number().int().positive().max(14_400).default(90),
  audienceJoinMode: AudienceJoinModeSchema.default("direct"),
  audienceCapacityMode: z.enum(["p2p-5", "sfu-20"]).default("p2p-5"),
  browserSessionMode: BrowserSessionModeSchema.default("daily"),
  variables: z.array(PresentationVariableSchema).max(100).default([]),
  sensitiveVariables: z.array(SensitiveRuntimeVariableSchema).max(30).default([]),
  brand: ProjectBrandSchema.default({
    primaryColor: "#37d0ba",
    statusBackgroundColor: "#172533",
    privacyMessage: "演示准备中",
    loadingMessage: "正在准备业务画面",
    offlineLabel: "离线备用",
    endTitle: "演示结束",
    endDescription: "感谢观看",
    audienceTitle: "Showit 观众屏"
  }),
  layout: ProjectLayoutSchema,
  connectors: z.array(PresentationConnectorSchema).max(50),
  pages: z.array(PresentationPageSchema).min(1).max(200)
});

export const ProjectVersionSchema = z.object({
  id: identifier,
  projectId: identifier,
  version: z.number().int().positive(),
  kind: z.enum(["publish", "manual", "auto"]).default("publish"),
  createdAt: z.number().int().positive(),
  publishedBy: z.string().trim().max(120).default(""),
  changeSummary: z.string().max(500),
  snapshot: ProjectSchema
});

export const RehearsalPageTimingSchema = z.object({
  pageId: identifier,
  plannedMs: z.number().int().nonnegative(),
  actualMs: z.number().int().nonnegative()
});

export const RehearsalSchema = z.object({
  id: identifier,
  projectId: identifier,
  startedAt: z.number().int().positive(),
  endedAt: z.number().int().positive(),
  totalElapsedMs: z.number().int().nonnegative(),
  note: z.string().max(2_000),
  pages: z.array(RehearsalPageTimingSchema).min(1).max(200)
});

export const ForcedStepCompletionSchema = z.object({
  stepId: identifier,
  reason: z.string().trim().min(1).max(500),
  at: z.number().int().positive()
});

export const PresentationSessionSchema = z.object({
  id: identifier,
  projectId: identifier,
  currentPageIndex: z.number().int().nonnegative(),
  completedStepIds: z.array(identifier),
  forcedStepCompletions: z.array(ForcedStepCompletionSchema).max(20_000).default([]),
  timerStatus: TimerStatusSchema,
  totalElapsedMs: z.number().nonnegative(),
  pageElapsedMs: z.number().nonnegative(),
  sectionElapsedMs: z.number().nonnegative().default(0),
  timerStartedAt: z.number().int().nullable(),
  autoAdvanceElapsedMs: z.number().nonnegative().default(0),
  autoAdvanceStartedAt: z.number().int().nullable().default(null),
  screenMode: ScreenModeSchema,
  offlineFallbackPageId: identifier.nullable().default(null),
  offlineNetworkGrants: z.array(z.object({
    pageId: identifier,
    origin: explicitNetworkOrigin
  }).strict()).max(4_000).default([]),
  pendingHighRiskStepId: identifier.nullable().default(null),
  browserSessionMode: BrowserSessionModeSchema.default("daily"),
  annotationTool: z.enum(["none", "laser", "circle", "mask"]),
  circles: z.array(CircleSchema),
  laser: LaserPointSchema.nullable(),
  audienceStatus: AudienceStatusSchema,
  audienceCount: z.number().int().nonnegative().max(20),
  sequence: z.number().int().nonnegative()
});

export const AudienceEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    sessionId: identifier,
    seq: z.number().int().nonnegative(),
    nonce: z.string().min(12).max(128),
    at: z.number().int().positive()
  }),
  z.object({
    type: z.literal("snapshot"),
    sessionId: identifier,
    seq: z.number().int().nonnegative(),
    nonce: z.string().min(12).max(128),
    at: z.number().int().positive(),
    project: ProjectSchema,
    session: PresentationSessionSchema
  }),
  z.object({
    type: z.literal("laser"),
    sessionId: identifier,
    seq: z.number().int().nonnegative(),
    nonce: z.string().min(12).max(128),
    at: z.number().int().positive(),
    laser: LaserPointSchema.nullable()
  }),
  z.object({
    type: z.literal("bye"),
    sessionId: identifier,
    seq: z.number().int().nonnegative(),
    nonce: z.string().min(12).max(128),
    at: z.number().int().positive()
  })
]);

export type Project = z.infer<typeof ProjectSchema>;
export type ProjectVersion = z.infer<typeof ProjectVersionSchema>;
export type Rehearsal = z.infer<typeof RehearsalSchema>;
export type RehearsalPageTiming = z.infer<typeof RehearsalPageTimingSchema>;
export type ForcedStepCompletion = z.infer<typeof ForcedStepCompletionSchema>;
export type ProjectLayout = z.infer<typeof ProjectLayoutSchema>;
export type ProjectBrand = z.infer<typeof ProjectBrandSchema>;
export type PresentationVariable = z.infer<typeof PresentationVariableSchema>;
export type SensitiveRuntimeVariable = z.infer<typeof SensitiveRuntimeVariableSchema>;
export type OfflineFallback = z.infer<typeof OfflineFallbackSchema>;
export type OfflinePackageResource = z.infer<typeof OfflinePackageResourceSchema>;
export type PresentationPage = z.infer<typeof PresentationPageSchema>;
export type PresentationStep = z.infer<typeof PresentationStepSchema>;
export type RecordedAction = z.infer<typeof RecordedActionSchema>;
export type ExpectedCondition = z.infer<typeof ExpectedConditionSchema>;
export type ElementLocator = z.infer<typeof ElementLocatorSchema>;
export type InputValueSource = z.infer<typeof InputValueSourceSchema>;
export type StepKind = z.infer<typeof StepKindSchema>;
export type PresentationConnector = z.infer<typeof PresentationConnectorSchema>;
export type PresentationSession = z.infer<typeof PresentationSessionSchema>;
export type AudienceEvent = z.infer<typeof AudienceEventSchema>;
export type Circle = z.infer<typeof CircleSchema>;
export type PrivacyMask = z.infer<typeof PrivacyMaskSchema>;
export type LaserPoint = z.infer<typeof LaserPointSchema>;
export type ScreenMode = z.infer<typeof ScreenModeSchema>;

export function validateBusinessUrl(value: string): { valid: boolean; reason?: string } {
  try {
    const url = new URL(value);
    if (isAllowedBusinessUrl(url.toString())) return { valid: true };
    return { valid: false, reason: "只允许 HTTPS，或 localhost/127.0.0.1 的 HTTP 地址，且不能包含凭据或敏感查询参数。" };
  } catch {
    return { valid: false, reason: "请输入完整的 HTTP(S) URL。" };
  }
}

export function validateBusinessUrlTemplate(value: string): { valid: boolean; reason?: string } {
  return isAllowedBusinessUrlTemplate(value)
    ? { valid: true }
    : { valid: false, reason: "URL 模板必须使用 HTTPS 或本机开发 Origin，不能包含凭据或敏感查询参数，变量只能出现在路径、查询或 Hash 中。" };
}

export function createSessionId(): string {
  const random = globalThis.crypto?.getRandomValues
    ? Array.from(globalThis.crypto.getRandomValues(new Uint32Array(2)))
        .map((value) => value.toString(36))
        .join("")
    : Math.random().toString(36).slice(2);
  return `session-${Date.now().toString(36)}-${random}`.slice(0, 120);
}
