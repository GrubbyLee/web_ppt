import test from "node:test";
import assert from "node:assert/strict";
import { captureHandoffDecision } from "./tab-handoff.js";

test("capture handoff only follows a distinct authorized safe tab", () => {
  assert.equal(captureHandoffDecision(1, 2, "https://system.example.com/page", true), "handoff");
  assert.equal(captureHandoffDecision(1, 2, "https://login.example.com/sso", false), "authorize");
  assert.equal(captureHandoffDecision(1, 1, "https://system.example.com/page", true), "ignore");
  assert.equal(captureHandoffDecision(1, 2, "file:///etc/passwd", true), "block");
});
