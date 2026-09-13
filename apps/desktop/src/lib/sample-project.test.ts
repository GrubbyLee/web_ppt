import { describe, expect, it } from "vitest";
import { ProjectSchema } from "@showit/contracts";
import { runProjectPreflight } from "./preflight";
import { sampleProject } from "./sample-project";

describe("LCAPIM golden sample", () => {
  it("keeps all 18 configured pages valid and ordered", () => {
    expect(ProjectSchema.safeParse(sampleProject).success).toBe(true);
    expect(sampleProject.pages).toHaveLength(18);
    expect(new Set(sampleProject.pages.map((page) => page.id)).size).toBe(18);
    expect(sampleProject.pages.map((page) => page.order)).toEqual(Array.from({ length: 18 }, (_, index) => index));
    for (const page of sampleProject.pages) {
      expect(page.url).toMatch(/^http:\/\/localhost:3000\//);
      expect(page.script.markdown.trim().length).toBeGreaterThan(0);
      expect(page.script.steps.length).toBeGreaterThan(0);
      expect(page.connectorId).toBe("lc-apim-local");
    }
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
