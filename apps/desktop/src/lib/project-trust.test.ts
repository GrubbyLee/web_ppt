import { describe, expect, it } from "vitest";
import { ProjectSchema } from "@showit/contracts";
import { sampleProject } from "./sample-project";
import { createProject, fingerprintProject } from "./project-workspace";
import { inspectProjectImport, projectTrustState, trustProject } from "./project-trust";

describe("project import inspection", () => {
  it("reports origins, embedded HTML and high-risk configuration before import", () => {
    const project = createProject("导入检查");
    project.connectors = [{ id: "connector", name: "连接器", origin: "https://example.com", mode: "extension", permission: "automate", securityMode: "interactive", environment: "test", requestHeaders: [], basicAuthInstructions: "", loginPaths: [], logoutPaths: [], roleSwitchPaths: [], sandboxPermissions: [], allowedOrigins: ["https://cdn.example.com"] }];
    project.pages[0] = { ...project.pages[0]!, url: "https://example.com/app", offline: { kind: "html", content: "<main>离线内容</main>" }, script: { ...project.pages[0]!.script, steps: [{ ...project.pages[0]!.script.steps[0]!, risk: "high" }] } };
    expect(inspectProjectImport(project)).toMatchObject({ origins: ["https://cdn.example.com", "https://example.com"], offlineHtmlPages: 1, automatedConnectors: 1, highRiskSteps: 1 });
  });

  it("invalidates trust when imported project content changes", async () => {
    localStorage.clear();
    const project = createProject("哈希信任");
    expect(await projectTrustState(project)).toBe("untracked");
    await trustProject(project);
    expect(await projectTrustState(project)).toBe("trusted");
    project.description = "内容已变化";
    expect(await projectTrustState(project)).toBe("changed");
  });

  it("keeps trust stable across a schema round-trip", async () => {
    // A project saved as a raw literal and reloaded through ProjectSchema is
    // structurally identical; key insertion order must not flip trust to
    // "changed" (which bounced the presenter back to the library on launch).
    const roundTripped = ProjectSchema.parse(sampleProject);
    expect(await fingerprintProject(sampleProject)).toBe(await fingerprintProject(roundTripped));
    localStorage.clear();
    await trustProject(sampleProject);
    expect(await projectTrustState(roundTripped)).toBe("trusted");
  });
});
