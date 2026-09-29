import { describe, expect, it } from "vitest";
import { ProjectSchema, validateBusinessUrl } from "@showit/contracts";
import { runProjectPreflight } from "./preflight";
import { migrateLegacyBundledSample, sampleProject } from "./sample-project";

describe("built-in demo sample (云枢)", () => {
  it("keeps all 18 configured pages valid and ordered", () => {
    expect(ProjectSchema.safeParse(sampleProject).success).toBe(true);
    expect(sampleProject.pages).toHaveLength(18);
    expect(new Set(sampleProject.pages.map((page) => page.id)).size).toBe(18);
    expect(sampleProject.pages.map((page) => page.order)).toEqual(Array.from({ length: 18 }, (_, index) => index));
    for (const page of sampleProject.pages) {
      expect(page.script.markdown.trim().length).toBeGreaterThan(0);
      expect(page.script.steps.length).toBeGreaterThan(0);
    }
  });

  it("maps live pages to built-in demo views and chapters to stage slides", () => {
    const livePages = sampleProject.pages.filter((page) => page.pageType === "business");
    expect(livePages.map((page) => page.url)).toEqual([
      "demo://marketplace",
      "demo://subscriptions",
      "demo://studio",
      "demo://registry",
      "demo://approvals",
      "demo://operations",
      "demo://admin-controls"
    ]);
    for (const page of livePages) {
      expect(validateBusinessUrl(page.url!).valid).toBe(true);
      expect(page.connectorId).toBeUndefined();
    }
    const slidePages = sampleProject.pages.filter((page) => page.pageType === "fixed");
    expect(slidePages).toHaveLength(10);
    expect(slidePages.every((page) => page.url === undefined)).toBe(true);
    expect(sampleProject.pages.at(-1)?.pageType).toBe("end");
  });

  it("exercises the full product feature set through executable steps", () => {
    const stepsWithActions = sampleProject.pages.flatMap((page) => page.script.steps).filter((step) => step.recordedAction);
    expect(stepsWithActions.length).toBeGreaterThanOrEqual(15);

    const loginPage = sampleProject.pages.find((page) => page.id === "visitor-live-demo")!;
    const passwordFill = loginPage.script.steps.find((step) => step.recordedAction?.type === "fill" && step.recordedAction.input.source === "sensitive");
    expect(passwordFill?.recordedAction).toMatchObject({ type: "fill", input: { source: "sensitive", key: "demoPassword" } });
    expect(sampleProject.sensitiveVariables.map((variable) => variable.key)).toContain("demoPassword");

    const registryPage = sampleProject.pages.find((page) => page.id === "producer-live-demo")!;
    const publishStep = registryPage.script.steps.find((step) => step.risk === "high");
    expect(publishStep?.recordedAction).toMatchObject({ type: "click", locator: { strategy: "testid", value: "publish-api" } });
    expect(publishStep?.expectedCondition).toMatchObject({ type: "element" });

    const chained = loginPage.script.steps.find((step) => step.autoContinue === true);
    expect(chained?.expectedCondition).toBeDefined();

    expect(loginPage.offline?.kind).toBe("html");
  });

  it("migrates only untouched legacy bundled samples", () => {
    const legacy = migrateLegacyBundledSample(sampleProject);
    expect(legacy).toBeNull();

    const stored = {
      id: sampleProject.id,
      name: "客户已修改"
    };
    expect(migrateLegacyBundledSample(stored as never)).toBeNull();
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
