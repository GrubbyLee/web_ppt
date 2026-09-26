import { describe, expect, it } from "vitest";
import { createProject } from "./project-workspace";
import { runProjectPreflight } from "./preflight";

describe("project preflight", () => {
  it("rejects unresolved variables and duplicate keys", () => {
    const project = createProject("预检项目");
    project.variables = [{ key: "customer", value: "甲" }, { key: "customer", value: "乙" }];
    project.pages[0]!.script.markdown = "客户：{{project.missing}}";
    const report = runProjectPreflight(project);
    expect(report.canPublish).toBe(false);
    expect(report.errors.map((item) => item.message).join(" ")).toContain("项目变量重复");
    expect(report.errors.map((item) => item.message).join(" ")).toContain("未定义变量");
  });

  it("rejects resolved URLs outside the connector whitelist", () => {
    const project = createProject("预检项目");
    project.connectors = [{
      id: "connector",
      name: "业务连接器",
      origin: "https://allowed.example.com",
      mode: "iframe",
      permission: "observe",
      securityMode: "interactive",
      environment: "test",
      requestHeaders: [],
      basicAuthInstructions: "",
      loginPaths: [],
      logoutPaths: [],
      roleSwitchPaths: [],
      sandboxPermissions: ["allow-scripts"],
      allowedOrigins: ["https://allowed.example.com"]
    }];
    project.pages[0] = { ...project.pages[0]!, connectorId: "connector", url: "https://blocked.example.com/page" };
    const report = runProjectPreflight(project);
    expect(report.canPublish).toBe(false);
    expect(report.errors.some((item) => item.id.startsWith("origin-"))).toBe(true);
  });

  it("rejects request protection outside extension mode", () => {
    const project = createProject("保护模式预检");
    project.connectors = [{
      id: "connector",
      name: "业务连接器",
      origin: "https://example.com",
      mode: "iframe",
      permission: "observe",
      securityMode: "request-protection",
      environment: "test",
      requestHeaders: [],
      basicAuthInstructions: "",
      loginPaths: ["/login"],
      logoutPaths: ["/logout"],
      roleSwitchPaths: ["/api/role/switch"],
      sandboxPermissions: ["allow-scripts"],
      allowedOrigins: ["https://example.com"]
    }];
    project.pages[0] = { ...project.pages[0]!, connectorId: "connector", url: "https://example.com/page" };
    const report = runProjectPreflight(project);
    expect(report.canPublish).toBe(false);
    expect(report.errors.some((item) => item.id.startsWith("protection-"))).toBe(true);
  });

  it("requires an uploaded offline fallback before publishing", () => {
    const project = createProject("离线备用预检");
    project.pages[0] = { ...project.pages[0]!, offline: { kind: "image" } };
    expect(runProjectPreflight(project).canPublish).toBe(false);
    project.pages[0] = { ...project.pages[0]!, offline: { kind: "html", content: "<main>备用内容</main>" } };
    const report = runProjectPreflight(project);
    expect(report.errors.some((item) => item.id.startsWith("offline-"))).toBe(false);
    expect(report.items.some((item) => item.id.startsWith("offline-") && item.state === "ok")).toBe(true);
  });

  it("checks configured connector role mappings while allowing login-only probes", () => {
    const project = createProject("会话预检项目");
    project.connectors = [{
      id: "connector", name: "业务连接器", origin: "https://example.com", mode: "iframe", permission: "observe", securityMode: "interactive", environment: "test", requestHeaders: [], basicAuthInstructions: "", loginPaths: [], logoutPaths: [], roleSwitchPaths: [], sandboxPermissions: ["allow-scripts"], allowedOrigins: ["https://example.com"],
      sessionProbe: { path: "/api/me", userPath: ["data", "user"], primaryRoleField: "role", rolesField: "roles", roleMappings: [{ presentationRole: "演讲者", connectorRole: "speaker" }, { presentationRole: "演讲者", connectorRole: "speaker-alt" }] }
    }];
    project.pages[0] = { ...project.pages[0]!, connectorId: "connector", url: "https://example.com/page" };
    const duplicateReport = runProjectPreflight(project);
    expect(duplicateReport.errors.some((item) => item.id === "session-role-mapping-connector")).toBe(true);
    project.connectors[0]!.sessionProbe!.roleMappings = [{ presentationRole: "其他角色", connectorRole: "other" }];
    const missingReport = runProjectPreflight(project);
    expect(missingReport.warnings.some((item) => item.id === `session-role-${project.pages[0]!.id}`)).toBe(true);
    project.connectors[0]!.sessionProbe!.roleMappings = [];
    expect(runProjectPreflight(project).warnings.some((item) => item.id.startsWith("session-role-"))).toBe(false);
  });
});
