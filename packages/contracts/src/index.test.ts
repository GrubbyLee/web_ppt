import { describe, expect, it } from "vitest";
import { ElementLocatorSchema, ExpectedConditionSchema, OfflineFallbackSchema, PresentationConnectorSchema, PresentationSessionSchema, PresentationStepSchema, PrivacyMaskSchema, ProjectSchema, ProjectVersionSchema, RecordedActionSchema, RehearsalSchema, SensitiveRuntimeVariableSchema, validateBusinessUrl, validateBusinessUrlTemplate } from "./index";

describe("validateBusinessUrl", () => {
  it("accepts HTTPS and explicit local development URLs", () => {
    expect(validateBusinessUrl("https://example.com/app")).toEqual({ valid: true });
    expect(validateBusinessUrl("http://localhost:3000/app")).toEqual({ valid: true });
  });

  it("rejects unsafe protocols and non-local HTTP", () => {
    expect(validateBusinessUrl("javascript:alert(1)").valid).toBe(false);
    expect(validateBusinessUrl("data:text/html,unsafe").valid).toBe(false);
    expect(validateBusinessUrl("http://example.com/app").valid).toBe(false);
    expect(validateBusinessUrl("https://demo:password@example.com/app").valid).toBe(false);
    expect(validateBusinessUrl("https://example.com/app?access_token=private").valid).toBe(false);
  });

  it("accepts only literal built-in demo views", () => {
    expect(validateBusinessUrl("demo://marketplace").valid).toBe(true);
    expect(validateBusinessUrl("demo://studio-details").valid).toBe(true);
    expect(validateBusinessUrl("demo://Marketplace").valid).toBe(false);
    expect(validateBusinessUrl("demo://marketplace?q=1").valid).toBe(false);
    expect(validateBusinessUrl("demo://marketplace/path").valid).toBe(false);
    expect(validateBusinessUrl("demo://").valid).toBe(false);
    expect(validateBusinessUrlTemplate("demo://{{project.view}}").valid).toBe(false);
  });

  it("allows templates below the URL authority and rejects host interpolation", () => {
    expect(validateBusinessUrlTemplate("https://example.com/customer/{{project.customer}}").valid).toBe(true);
    expect(validateBusinessUrlTemplate("https://{{project.host}}/customer").valid).toBe(false);
    expect(validateBusinessUrlTemplate("https://example.com/customer?api_key=private").valid).toBe(false);
  });
});

describe("project contract", () => {
  it("rejects an empty project page list", () => {
    const result = ProjectSchema.safeParse({
      id: "project",
      formatVersion: 1,
      name: "项目",
      description: "",
      status: "draft",
      totalPlannedSeconds: 60,
      autoAdvanceEnabled: false,
      layout: { stagePercent: 56, preset: "stage", noteFontScale: 1 },
      connectors: [],
      pages: []
    });
    expect(result.success).toBe(false);
  });

  it("migrates projects without branding to the default audience copy", () => {
    const result = ProjectSchema.safeParse({
      id: "project",
      formatVersion: 1,
      name: "项目",
      description: "",
      status: "draft",
      totalPlannedSeconds: 60,
      autoAdvanceEnabled: false,
      layout: { stagePercent: 56, preset: "stage", noteFontScale: 1 },
      connectors: [],
      pages: [{
        id: "page",
        order: 0,
        title: "页面",
        section: "章节",
        purpose: "目的",
        role: "角色",
        businessLabel: "业务页",
        estimatedSeconds: 60,
        script: { markdown: "内容", steps: [{ id: "step", kind: "say", text: "讲述", risk: "normal" }] }
      }]
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.brand.privacyMessage).toBe("演示准备中");
      expect(result.data.audienceJoinMode).toBe("direct");
      expect(result.data.audienceCapacityMode).toBe("p2p-5");
      expect(result.data.browserSessionMode).toBe("daily");
      expect(result.data.autoAdvanceSeconds).toBe(90);
    }
  });

  it("rejects unsafe page URLs inside a project", () => {
    const result = ProjectSchema.safeParse({
      id: "project",
      formatVersion: 1,
      name: "项目",
      description: "",
      status: "draft",
      totalPlannedSeconds: 60,
      autoAdvanceEnabled: false,
      layout: { stagePercent: 56, preset: "stage", noteFontScale: 1 },
      connectors: [],
      pages: [{
        id: "page",
        order: 0,
        title: "页面",
        section: "章节",
        purpose: "目的",
        role: "角色",
        businessLabel: "业务页",
        url: "javascript:alert(1)",
        estimatedSeconds: 60,
        script: { markdown: "内容", steps: [{ id: "step", kind: "say", text: "讲述", risk: "normal" }] }
      }]
    });
    expect(result.success).toBe(false);
  });
});

describe("presentation session contract", () => {
  it("adds chapter and automatic-advance clocks to legacy sessions", () => {
    const session = PresentationSessionSchema.parse({
      id: "session",
      projectId: "project",
      currentPageIndex: 0,
      completedStepIds: [],
      timerStatus: "idle",
      totalElapsedMs: 0,
      pageElapsedMs: 0,
      timerStartedAt: null,
      screenMode: "normal",
      annotationTool: "none",
      circles: [],
      laser: null,
      audienceStatus: "disconnected",
      audienceCount: 0,
      sequence: 0
    });

    expect(session).toMatchObject({
      sectionElapsedMs: 0,
      autoAdvanceElapsedMs: 0,
      autoAdvanceStartedAt: null
    });
  });
});

describe("connector contract", () => {
  const legacyConnector = {
    id: "connector",
    name: "业务连接器",
    origin: "https://example.com",
    mode: "extension",
    sandboxPermissions: [],
    allowedOrigins: ["https://example.com"]
  };

  it("applies safe defaults when loading legacy connector data", () => {
    const connector = PresentationConnectorSchema.parse(legacyConnector);
    expect(connector.permission).toBe("assist");
    expect(connector.securityMode).toBe("interactive");
    expect(connector.loginPaths).toEqual([]);
    expect(connector.logoutPaths).toEqual([]);
    expect(connector.roleSwitchPaths).toEqual([]);
    expect(connector.environment).toBe("默认环境");
    expect(connector.requestHeaders).toEqual([]);
  });

  it("allows non-sensitive request metadata but rejects stored credentials", () => {
    expect(PresentationConnectorSchema.safeParse({ ...legacyConnector, requestHeaders: [{ name: "X-Demo-Tenant", value: "customer-a" }], basicAuthInstructions: "在浏览器登录弹窗中使用现场账号" }).success).toBe(true);
    expect(PresentationConnectorSchema.safeParse({ ...legacyConnector, requestHeaders: [{ name: "Authorization", value: "Basic secret" }] }).success).toBe(false);
    expect(PresentationConnectorSchema.safeParse({ ...legacyConnector, requestHeaders: [{ name: "X-Api-Key", value: "secret" }] }).success).toBe(false);
    expect(PresentationConnectorSchema.safeParse({ ...legacyConnector, requestHeaders: [{ name: "Origin", value: "https://attacker.example" }] }).success).toBe(false);
    expect(PresentationConnectorSchema.safeParse({ ...legacyConnector, requestHeaders: [{ name: "X-Forwarded-Host", value: "attacker.example" }] }).success).toBe(false);
    expect(PresentationConnectorSchema.safeParse({ ...legacyConnector, requestHeaders: [{ name: "Connection", value: "keep-alive" }] }).success).toBe(false);
    expect(PresentationConnectorSchema.safeParse({ ...legacyConnector, origin: "https://demo:password@example.com" }).success).toBe(false);
    expect(PresentationConnectorSchema.safeParse({ ...legacyConnector, allowedOrigins: ["https://example.com?token=private"] }).success).toBe(false);
  });

  it("rejects ambiguous or traversing login and logout paths", () => {
    for (const path of ["login", "//evil.example/login", "/login?next=/admin", "/login#callback", "/a/../login", "/a/%2e%2e/login", "/a\\login"]) {
      expect(PresentationConnectorSchema.safeParse({ ...legacyConnector, loginPaths: [path] }).success, path).toBe(false);
      expect(PresentationConnectorSchema.safeParse({ ...legacyConnector, roleSwitchPaths: [path] }).success, path).toBe(false);
    }
    expect(PresentationConnectorSchema.safeParse({ ...legacyConnector, loginPaths: ["/login", "/sso/callback"] }).success).toBe(true);
    expect(PresentationConnectorSchema.safeParse({ ...legacyConnector, roleSwitchPaths: ["/api/role/switch"] }).success).toBe(true);
  });

  it("supports configurable session and role probes without accepting unsafe paths or fields", () => {
    const sessionProbe = {
      path: "/api/session/current",
      userPath: ["payload", "principal"],
      primaryRoleField: "primaryRole",
      rolesField: "grants",
      roleMappings: [{ presentationRole: "审批人", connectorRole: "reviewer" }]
    };
    expect(PresentationConnectorSchema.safeParse({ ...legacyConnector, sessionProbe }).success).toBe(true);
    for (const path of ["session/current", "//evil.example/me", "/api/../session", "/api/session?debug=1"]) {
      expect(PresentationConnectorSchema.safeParse({ ...legacyConnector, sessionProbe: { ...sessionProbe, path } }).success, path).toBe(false);
    }
    expect(PresentationConnectorSchema.safeParse({ ...legacyConnector, sessionProbe: { ...sessionProbe, primaryRoleField: "role.name" } }).success).toBe(false);
  });
});

describe("offline fallback contract", () => {
  it("only accepts supported embedded media and bounded HTML", () => {
    expect(OfflineFallbackSchema.safeParse({ kind: "image", dataUrl: "data:image/png;base64,AA==" }).success).toBe(true);
    expect(OfflineFallbackSchema.safeParse({ kind: "video", dataUrl: "data:video/mp4;base64,AA==" }).success).toBe(true);
    expect(OfflineFallbackSchema.safeParse({ kind: "image", dataUrl: "https://example.com/image.png" }).success).toBe(false);
    expect(OfflineFallbackSchema.safeParse({ kind: "html", content: "<main>本地内容</main>" }).success).toBe(true);
    expect(OfflineFallbackSchema.safeParse({ kind: "html", content: "<script src=\"app.js\"></script>", resources: [{ path: "app.js", dataUrl: "data:application/javascript;base64,YWxlcnQoMSk=" }], allowedNetworkOrigins: ["https://api.example.com"] }).success).toBe(true);
    expect(OfflineFallbackSchema.safeParse({ kind: "html", content: "x", resources: [{ path: "../app.js", dataUrl: "data:application/javascript;base64,eA==" }] }).success).toBe(false);
    expect(OfflineFallbackSchema.safeParse({ kind: "html", content: "x", allowedNetworkOrigins: ["https://api.example.com/path"] }).success).toBe(false);
  });
});

describe("sensitive runtime variable contract", () => {
  it("stores metadata but has no persistent value field", () => {
    expect(SensitiveRuntimeVariableSchema.safeParse({ key: "apiToken", label: "API Token", required: true, expiresAfterMinutes: 60 }).success).toBe(true);
    expect(SensitiveRuntimeVariableSchema.safeParse({ key: "apiToken", label: "API Token", value: "must-not-persist", required: true, expiresAfterMinutes: 60 }).success).toBe(false);
  });
});

describe("recorded step contracts", () => {
  it("loads legacy steps with conservative execution defaults", () => {
    const step = PresentationStepSchema.parse({ id: "step", kind: "act", text: "执行操作" });
    expect(step).toMatchObject({ execution: "hint", conditionTimeoutSeconds: 8, risk: "normal", autoContinue: false });
  });

  it("accepts automatic continuation only as an explicit boolean", () => {
    expect(PresentationStepSchema.parse({ id: "step", kind: "expect", text: "等待" }).autoContinue).toBe(false);
    expect(PresentationStepSchema.safeParse({ id: "step", kind: "expect", text: "等待", autoContinue: true }).success).toBe(true);
    expect(PresentationStepSchema.safeParse({ id: "step", kind: "expect", text: "等待", autoContinue: "yes" }).success).toBe(false);
  });

  it("accepts stable locators and rejects sensitive or ambiguous action data", () => {
    expect(ElementLocatorSchema.safeParse({ strategy: "testid", value: "save-button" }).success).toBe(true);
    expect(ElementLocatorSchema.safeParse({ strategy: "css", value: ".button" }).success).toBe(false);
    expect(ElementLocatorSchema.safeParse({ strategy: "id", value: "password-field" }).success).toBe(false);
    expect(RecordedActionSchema.safeParse({ type: "click", locator: { strategy: "aria", value: "保存" } }).success).toBe(true);
    expect(RecordedActionSchema.safeParse({ type: "click", locator: { strategy: "aria", value: "保存" }, value: "secret" }).success).toBe(false);
    expect(RecordedActionSchema.safeParse({ type: "navigate", url: "javascript:alert(1)" }).success).toBe(false);
    expect(RecordedActionSchema.safeParse({ type: "fill", locator: { strategy: "id", value: "password" }, input: { source: "sensitive", key: "loginPassword" } }).success).toBe(true);
    expect(RecordedActionSchema.safeParse({ type: "fill", locator: { strategy: "id", value: "field" }, input: { source: "sensitive", key: "loginPassword" }, value: "must-not-persist" }).success).toBe(false);
  });

  it("validates expected conditions and bounded timeouts", () => {
    expect(ExpectedConditionSchema.safeParse({ type: "element", locator: { strategy: "id", value: "result" } }).success).toBe(true);
    expect(ExpectedConditionSchema.safeParse({ type: "text", value: "" }).success).toBe(false);
    expect(ExpectedConditionSchema.safeParse({ type: "url", value: "http://example.com/result" }).success).toBe(false);
    expect(PresentationStepSchema.safeParse({ id: "step", kind: "expect", text: "等待", conditionTimeoutSeconds: 31 }).success).toBe(false);
  });
});

describe("privacy mask contract", () => {
  it("allows only stable non-sensitive DOM bindings", () => {
    expect(PrivacyMaskSchema.safeParse({ id: "mask", x1: 0, y1: 0, x2: 1, y2: 1, locator: { strategy: "testid", value: "customer-email" } }).success).toBe(true);
    expect(PrivacyMaskSchema.safeParse({ id: "mask", x1: 0, y1: 0, x2: 1, y2: 1, locator: { strategy: "id", value: "password" } }).success).toBe(false);
  });
});

describe("history contracts", () => {
  it("requires version snapshots and rehearsal page timings", () => {
    expect(ProjectVersionSchema.safeParse({ id: "version-1", projectId: "project", version: 1 }).success).toBe(false);
    expect(RehearsalSchema.safeParse({ id: "rehearsal-1", projectId: "project", pages: [] }).success).toBe(false);
  });
});
