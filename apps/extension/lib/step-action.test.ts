import { describe, expect, it } from "vitest";
import { sampleProject } from "./sample-project";
import { setRuntimeSecrets, clearRuntimeSecrets } from "./runtime-secrets";
import { resolveRecordedAction } from "./step-action";

describe("step input actions", () => {
  const page = sampleProject.pages[0]!;
  const action = { type: "fill" as const, locator: { strategy: "id" as const, value: "password" }, input: { source: "sensitive" as const, key: "loginPassword" } };

  it("resolves a sensitive value only from the active in-memory session", () => {
    setRuntimeSecrets("step-session", [{ key: "loginPassword", label: "登录密码", required: true, expiresAfterMinutes: 1 }], { loginPassword: "never-persisted" });
    expect(resolveRecordedAction(action, sampleProject, page, "step-session")).toEqual({ type: "fill", locator: action.locator, value: "never-persisted" });
    clearRuntimeSecrets("step-session");
    expect(() => resolveRecordedAction(action, sampleProject, page, "step-session")).toThrow("敏感变量已过期");
  });

  it("resolves ordinary project and page variables without treating them as secrets", () => {
    const project = { ...sampleProject, variables: [{ key: "tenant", value: "customer-a" }] };
    const variableAction = { type: "fill" as const, locator: { strategy: "testid" as const, value: "tenant" }, input: { source: "project" as const, key: "tenant" } };
    expect(resolveRecordedAction(variableAction, project, page, "session")).toMatchObject({ value: "customer-a" });
  });
});
