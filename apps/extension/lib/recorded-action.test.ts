import { describe, expect, it } from "vitest";
import { isValidExecutionAction, isValidExpectedCondition, isValidLocator, isValidRecordedAction, isValidStepExecution, normalizeMaskRect } from "./recorded-action";

describe("recorded actions", () => {
  it("only allow bounded non-sensitive stable locators", () => {
    expect(isValidLocator({ strategy: "testid", value: "save-button" })).toBe(true);
    expect(isValidLocator({ strategy: "css", value: ".save" })).toBe(false);
    expect(isValidLocator({ strategy: "id", value: "password" })).toBe(false);
    expect(isValidRecordedAction({ type: "click", locator: { strategy: "aria", value: "保存" } })).toBe(true);
    expect(isValidRecordedAction({ type: "click", locator: { strategy: "aria", value: "保存" }, value: "secret" })).toBe(false);
    expect(isValidRecordedAction({ type: "navigate", url: "javascript:alert(1)" })).toBe(false);
    expect(isValidRecordedAction({ type: "navigate", url: "https://demo:password@example.com/app" })).toBe(false);
    expect(isValidRecordedAction({ type: "navigate", url: "https://example.com/app?token=private" })).toBe(false);
    expect(isValidRecordedAction({ type: "fill", locator: { strategy: "id", value: "password" }, input: { source: "sensitive", key: "loginPassword" } })).toBe(true);
    expect(isValidRecordedAction({ type: "fill", locator: { strategy: "id", value: "password" }, value: "must-not-persist" })).toBe(false);
    expect(isValidExecutionAction({ type: "fill", locator: { strategy: "id", value: "password" }, value: "ephemeral" })).toBe(true);
    expect(isValidExecutionAction({ type: "fill", locator: { strategy: "id", value: "password" }, input: { source: "sensitive", key: "loginPassword" } })).toBe(false);
  });

  it("conditions and execution levels reject unsafe values", () => {
    expect(isValidExpectedCondition({ type: "element", locator: { strategy: "id", value: "result" } })).toBe(true);
    expect(isValidExpectedCondition({ type: "text", value: "" })).toBe(false);
    expect(isValidExpectedCondition({ type: "url", value: "http://example.com" })).toBe(false);
    expect(isValidStepExecution("auto")).toBe(true);
    expect(isValidStepExecution("force")).toBe(false);
  });

  it("privacy mask rectangles remain normalized to the visible viewport", () => {
    expect(normalizeMaskRect({ left: -20, top: 25, right: 1200, bottom: 600 }, 1000, 500)).toEqual({ x1: 0, y1: 0.05, x2: 1, y2: 1 });
    expect(normalizeMaskRect({ left: 0, top: 0, right: 1, bottom: 1 }, 0, 0)).toEqual({ x1: 0, y1: 0, x2: 1, y2: 1 });
  });
});
