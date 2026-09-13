import assert from "node:assert/strict";
import test from "node:test";
import { buildProtectionRules, sanitizeProtectionPaths } from "./request-protection.js";

test("request protection blocks mutations and allows only bounded login paths", () => {
  const rules = buildProtectionRules("https://example.com", ["/login"]);
  assert.equal(rules[0].action.type, "block");
  assert.deepEqual(rules[0].condition.requestMethods, ["post", "put", "patch", "delete"]);
  assert.equal(rules[1].priority, 2);
  const allow = new RegExp(rules[1].condition.regexFilter);
  assert.equal(allow.test("https://example.com/login"), true);
  assert.equal(allow.test("https://example.com/login/callback"), true);
  assert.equal(allow.test("https://example.com/login-evil"), false);
  assert.equal(allow.test("https://example.com.evil/login"), false);
});

test("request protection removes ambiguous paths before generating rules", () => {
  assert.deepEqual(sanitizeProtectionPaths(["/login", "/login", "//evil/login", "/a/../login", "/login?next=/", "/logout"]), ["/login", "/logout"]);
  const rules = buildProtectionRules("https://example.com", ["/login", "//evil/login"]);
  assert.equal(rules.length, 2);
});
