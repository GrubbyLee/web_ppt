import { describe, expect, it } from "vitest";
import { ProjectSchema } from "@showit/contracts";
import { runProjectPreflight } from "./preflight";
import { migrateLegacyBundledSample, sampleProject } from "./sample-project";

describe("LCAPIM golden sample", () => {
  it("keeps all 18 configured pages valid and ordered", () => {
    expect(ProjectSchema.safeParse(sampleProject).success).toBe(true);
    expect(sampleProject.pages).toHaveLength(18);
    expect(new Set(sampleProject.pages.map((page) => page.id)).size).toBe(18);
    expect(sampleProject.pages.map((page) => page.order)).toEqual(Array.from({ length: 18 }, (_, index) => index));
    for (const page of sampleProject.pages) {
      expect(page.url).toMatch(/^http:\/\/localhost:3001\/console\/\?view=/);
      expect(page.script.markdown.trim().length).toBeGreaterThan(0);
      expect(page.script.steps.length).toBeGreaterThan(0);
      expect(page.connectorId).toBe("lc-apim-local");
      expect(page.pageType).toBe("business");
    }
  });

  it("maps every page to its real read-only business view", () => {
    expect(sampleProject.connectors[0]).toMatchObject({ origin: "http://localhost:3001", mode: "iframe", securityMode: "readonly-proxy" });
    expect(sampleProject.pages.map((page) => page.url)).toEqual([
      "http://localhost:3001/console/?view=overview", "http://localhost:3001/console/?view=overview", "http://localhost:3001/console/?view=admin", "http://localhost:3001/console/?view=overview", "http://localhost:3001/console/?view=portal", "http://localhost:3001/console/?view=marketplace", "http://localhost:3001/console/?view=applications", "http://localhost:3001/console/?view=subscriptions", "http://localhost:3001/console/?view=studio", "http://localhost:3001/console/?view=studio-details", "http://localhost:3001/console/?view=registry", "http://localhost:3001/console/?view=overview", "http://localhost:3001/console/?view=approvals", "http://localhost:3001/console/?view=operations", "http://localhost:3001/console/?view=admin", "http://localhost:3001/console/?view=admin-controls", "http://localhost:3001/console/?view=admin", "http://localhost:3001/console/?view=overview"
    ]);
  });

  it("migrates only an untouched legacy bundled sample", () => {
    const legacy = structuredClone(sampleProject);
    legacy.connectors[0] = { ...legacy.connectors[0]!, origin: "http://localhost:3000", mode: "extension", allowedOrigins: ["http://localhost:3000"], loginPaths: ["/login", "/sso"], logoutPaths: ["/logout"], sessionProbe: undefined };
    legacy.pages = legacy.pages.map((page) => ({ ...page, pageType: page.id === "closing" ? "end" : "business", url: `http://localhost:3000/docs/demo/lc-apim-customer-demo/index.html?mode=presenter&showitPage=${page.id}` }));
    const persistedLegacy = ProjectSchema.parse(JSON.parse(JSON.stringify(legacy)));
    expect(migrateLegacyBundledSample(persistedLegacy)?.pages[0]?.url).toBe("http://localhost:3001/console/?view=overview");
    expect(migrateLegacyBundledSample({ ...legacy, name: "客户已修改" })).toBeNull();
  });

  it("upgrades the immediately preceding untouched bundled sample", () => {
    const prior = structuredClone(sampleProject);
    prior.connectors[0] = { ...prior.connectors[0]!, sessionProbe: undefined };
    const migrated = migrateLegacyBundledSample(prior);
    expect(migrated?.connectors[0]?.sessionProbe?.path).toBe("/api/lc/v1/session/status");
  });

  it("covers the five business roles and passes publish preflight", () => {
    expect(new Set(sampleProject.pages.map((page) => page.role))).toEqual(new Set([
      "访客",
      "能力使用者",
      "能力录入者",
      "能力运营者",
      "系统管理员"
    ]));
    expect(runProjectPreflight(sampleProject).errors).toEqual([]);
  });
});
