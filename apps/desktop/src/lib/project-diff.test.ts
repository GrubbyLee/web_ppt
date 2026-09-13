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
      connectors: [{ id: "connector", name: "连接器", origin: "https://example.com", mode: "extension" as const, permission: "assist" as const, securityMode: "interactive" as const, environment: "test", requestHeaders: [], basicAuthInstructions: "", loginPaths: [], logoutPaths: [], sandboxPermissions: [], allowedOrigins: ["https://example.com"] }]
    };
    const areas = diffProjects(previous, current).map((difference) => difference.area);
    expect(areas).toContain("脚本");
    expect(areas).toContain("页面");
    expect(areas).toContain("连接器");
  });
});
