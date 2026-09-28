import type { PresentationPage, PresentationStep, Project } from "@showit/contracts";
import { getRuntimeSecret } from "./runtime-secrets";

type FillAction = Extract<NonNullable<PresentationStep["recordedAction"]>, { type: "fill" }>;

export type ResolvedRecordedAction = Exclude<NonNullable<PresentationStep["recordedAction"]>, FillAction> | {
  type: "fill";
  locator: FillAction["locator"];
  value: string;
  label?: string;
};

export function resolveRecordedAction(
  action: NonNullable<PresentationStep["recordedAction"]>,
  project: Project,
  page: PresentationPage,
  sessionId: string
): ResolvedRecordedAction {
  if (action.type !== "fill") return action;
  const input = action.input;
  const value = input.source === "fixed"
    ? input.value
    : input.source === "project"
      ? project.variables.find((variable) => variable.key === input.key)?.value
      : input.source === "page"
        ? page.variables.find((variable) => variable.key === input.key)?.value
        : getRuntimeSecret(sessionId, input.key);
  if (value === undefined || value === null) {
    const name = input.source === "sensitive" ? "敏感变量已过期或尚未输入" : "输入变量未定义";
    throw new Error(`${name}：${input.source === "fixed" ? "固定值" : input.key}`);
  }
  return { type: "fill", locator: action.locator, value, ...(action.label ? { label: action.label } : {}) };
}
