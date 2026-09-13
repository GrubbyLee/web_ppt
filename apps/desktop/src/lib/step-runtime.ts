import type { PresentationPage, PresentationStep } from "@showit/contracts";

/** A verified normal step may start only another normal step on the same page. */
export function canAutoContinueAfterVerification(page: PresentationPage, step: PresentationStep): boolean {
  const index = page.script.steps.findIndex((item) => item.id === step.id);
  if (!step.autoContinue || step.risk !== "normal" || index < 0 || index >= page.script.steps.length - 1) return false;
  return page.script.steps[index + 1]?.risk === "normal";
}
