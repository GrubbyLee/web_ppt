import assert from "node:assert/strict";
import test from "node:test";
import { isValidExecutionAction, isValidExpectedCondition, isValidLocator, isValidRecordedAction, isValidStepExecution, normalizeMaskRect } from "./recorded-action.js";

test("recorded actions only allow bounded non-sensitive stable locators", () => {
  assert.equal(isValidLocator({ strategy: "testid", value: "save-button" }), true);
  assert.equal(isValidLocator({ strategy: "css", value: ".save" }), false);
  assert.equal(isValidLocator({ strategy: "id", value: "password" }), false);
  assert.equal(isValidRecordedAction({ type: "click", locator: { strategy: "aria", value: "保存" } }), true);
  assert.equal(isValidRecordedAction({ type: "click", locator: { strategy: "aria", value: "保存" }, value: "secret" }), false);
  assert.equal(isValidRecordedAction({ type: "navigate", url: "javascript:alert(1)" }), false);
  assert.equal(isValidRecordedAction({ type: "navigate", url: "https://demo:password@example.com/app" }), false);
  assert.equal(isValidRecordedAction({ type: "navigate", url: "https://example.com/app?token=private" }), false);
  assert.equal(isValidRecordedAction({ type: "fill", locator: { strategy: "id", value: "password" }, input: { source: "sensitive", key: "loginPassword" } }), true);
  assert.equal(isValidRecordedAction({ type: "fill", locator: { strategy: "id", value: "password" }, value: "must-not-persist" }), false);
  assert.equal(isValidExecutionAction({ type: "fill", locator: { strategy: "id", value: "password" }, value: "ephemeral" }), true);
  assert.equal(isValidExecutionAction({ type: "fill", locator: { strategy: "id", value: "password" }, input: { source: "sensitive", key: "loginPassword" } }), false);
});

test("recorded conditions and execution levels reject unsafe values", () => {
  assert.equal(isValidExpectedCondition({ type: "element", locator: { strategy: "id", value: "result" } }), true);
  assert.equal(isValidExpectedCondition({ type: "text", value: "" }), false);
  assert.equal(isValidExpectedCondition({ type: "url", value: "http://example.com" }), false);
  assert.equal(isValidStepExecution("auto"), true);
  assert.equal(isValidStepExecution("force"), false);
});

test("privacy mask rectangles remain normalized to the visible viewport", () => {
  assert.deepEqual(normalizeMaskRect({ left: -20, top: 25, right: 1200, bottom: 600 }, 1000, 500), { x1: 0, y1: 0.05, x2: 1, y2: 1 });
  assert.deepEqual(normalizeMaskRect({ left: 0, top: 0, right: 1, bottom: 1 }, 0, 0), { x1: 0, y1: 0, x2: 1, y2: 1 });
});
