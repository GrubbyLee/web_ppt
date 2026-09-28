import { describe, expect, it } from "vitest";
import { createPage, createProject } from "./project-workspace";
import { diffProjects } from "./project-diff";

describe("project diff", () => {
  it("reports page, script and connector changes", () => {
    const previous = createProject("差异项目");
    const current = {
      ...previous,
      pages: [
        { ...previous.pages[0]!, script: { ...previous.pages[0]!.script, markdown: "修改后的脚本" } },
        createPage(1)
      ],
      connectors: [{ id: "connector", name: "连接器", origin: "https://example.com", mode: "extension" as const, permission: "assist" as const, securityMode: "interactive" as const, environment: "test", requestHeaders: [], basicAuthInstructions: "", loginPaths: [], logoutPaths: [], roleSwitchPaths: [], sandboxPermissions: [], allowedOrigins: ["https://example.com"] }]
    };
    const areas = diffProjects(previous, current).map((difference) => difference.area);
    expect(areas).toContain("脚本");
    expect(areas).toContain("页面");
    expect(areas).toContain("连接器");
  });

  it("reports project-level audience, brand, sensitive-variable and auto-advance changes", () => {
    const previous = createProject("项目级差异");
    const current = {
      ...previous,
      autoAdvanceEnabled: true,
      autoAdvanceSeconds: 45,
      audienceJoinMode: "approval" as const,
      brand: { ...previous.brand, primaryColor: "#112233" },
      sensitiveVariables: [{ key: "code", label: "验证码", required: true, expiresAfterMinutes: 30 }]
    };
    const ids = diffProjects(previous, current).map((difference) => difference.id);
    expect(ids).toContain("project-auto-advance");
    expect(ids).toContain("project-audience");
    expect(ids).toContain("project-brand");
    expect(ids).toContain("project-sensitive-variables");
  });

  it("reports page duration, masks, offline and enable-state changes", () => {
    const previous = createProject("页面级差异");
    const current = {
      ...previous,
      pages: [
        {
          ...previous.pages[0]!,
          enabled: false,
          estimatedSeconds: 120,
          privacyMasks: [{ id: "mask-1", x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3, mode: "solid" as const }],
          offline: { kind: "html" as const, content: "<p>备用</p>" }
        }
      ]
    };
    const ids = diffProjects(previous, current).map((difference) => difference.id);
    expect(ids).toContain("page-enabled-" + previous.pages[0]!.id);
    expect(ids).toContain("page-duration-" + previous.pages[0]!.id);
    expect(ids).toContain("page-masks-" + previous.pages[0]!.id);
    expect(ids).toContain("page-offline-" + previous.pages[0]!.id);
  });
});
