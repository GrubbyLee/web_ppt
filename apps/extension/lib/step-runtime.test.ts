import { describe, expect, it } from "vitest";
import type { PresentationPage } from "@showit/contracts";
import { canAutoContinueAfterVerification } from "./step-runtime";

function createPage(): PresentationPage {
  return {
    id: "page",
    order: 0,
    pageType: "business",
    enabled: true,
    title: "验证",
    section: "测试",
    tags: [],
    purpose: "测试步骤续播",
    transitionNote: "",
    errorHandling: "",
    role: "演讲者",
    businessLabel: "业务页",
    estimatedSeconds: 60,
    variables: [],
    privacyMasks: [],
    script: {
      markdown: "测试",
      steps: [
        { id: "first", kind: "expect", text: "第一步", execution: "assist", conditionTimeoutSeconds: 8, risk: "normal", autoContinue: true },
        { id: "second", kind: "act", text: "第二步", execution: "assist", conditionTimeoutSeconds: 8, risk: "normal", autoContinue: false }
      ]
    }
  };
}

describe("verified step continuation", () => {
  it("continues only from an enabled normal step to a normal step on the same page", () => {
    const page = createPage();
    expect(canAutoContinueAfterVerification(page, page.script.steps[0]!)).toBe(true);
    expect(canAutoContinueAfterVerification(page, page.script.steps[1]!)).toBe(false);
  });

  it("does not continue into a high-risk step", () => {
    const page = createPage();
    page.script.steps[1] = { ...page.script.steps[1]!, risk: "high" };
    expect(canAutoContinueAfterVerification(page, page.script.steps[0]!)).toBe(false);
  });

  it("does not continue after a high-risk source step", () => {
    const page = createPage();
    page.script.steps[0] = { ...page.script.steps[0]!, risk: "high" };
    expect(canAutoContinueAfterVerification(page, page.script.steps[0]!)).toBe(false);
  });
});
