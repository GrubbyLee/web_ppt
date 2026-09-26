import assert from "node:assert/strict";
import test from "node:test";
import { buildProtectionRules, sanitizeProtectionPaths } from "./request-protection.js";

function allowPattern(origin, path) {
  return buildProtectionRules(origin, [path])[1].condition.regexFilter;
}

function matches(pattern, url) {
  // RE2 semantics: no lookahead, plain anchored match. Node's RegExp is a
  // superset, so a pattern free of lookarounds behaves identically here.
  return new RegExp(pattern).test(url);
}

test("sanitizes protection paths and rejects encoded or traversing entries", () => {
  assert.deepEqual(sanitizeProtectionPaths(["/login", "/login", "/sso/callback"]), ["/login", "/sso/callback"]);
  assert.deepEqual(sanitizeProtectionPaths(["login", "//evil.example/login", "/login?next=/admin", "/a/../login", "/login/%2e%2e/admin", "/login/%252e%252e/admin", "/login%2f..%2fadmin", 42, null]), []);
});

test("allow rules cover the allowlisted path and its plain subpaths", () => {
  const pattern = allowPattern("https://example.com", "/login");
  assert.equal(matches(pattern, "https://example.com/login"), true);
  assert.equal(matches(pattern, "https://example.com/login/"), true);
  assert.equal(matches(pattern, "https://example.com/login/callback"), true);
  assert.equal(matches(pattern, "https://example.com/login?next=%2Fhome"), true);
  assert.equal(matches(pattern, "https://example.com/login#fragment"), true);
  assert.equal(matches(pattern, "https://example.com/loginx"), false);
  assert.equal(matches(pattern, "https://evil.example/login"), false);
});

test("allow rules do not cover double-encoded traversal or sibling prefixes", () => {
  const pattern = allowPattern("https://example.com", "/login");
  assert.equal(matches(pattern, "https://example.com/login/%252e%252e/orders"), false);
  assert.equal(matches(pattern, "https://example.com/login/%2e%2e/orders"), false);
  assert.equal(matches(pattern, "https://example.com/login/..%2forders"), false);
});

test("block rule covers websockets and every non-read-only method", () => {
  const [block] = buildProtectionRules("https://example.com", []);
  assert.deepEqual([...block.condition.requestMethods].sort(), ["connect", "delete", "patch", "post", "put", "trace"]);
  assert.ok(block.condition.resourceTypes.includes("websocket"));
});

test("blocks writes on every protected origin while auth paths stay main-origin only", () => {
  const rules = buildProtectionRules(["https://example.com", "https://api.example.com"], ["/login"]);
  const patterns = rules.filter((rule) => rule.action.type === "block").map((rule) => rule.condition.regexFilter);
  assert.equal(patterns.length, 2);
  assert.ok(patterns.some((pattern) => matches(pattern, "https://api.example.com/orders")));
  assert.ok(patterns.some((pattern) => matches(pattern, "https://example.com/orders")));
  const allowPattern = rules.find((rule) => rule.action.type === "allow").condition.regexFilter;
  assert.equal(matches(allowPattern, "https://example.com/login"), true);
  assert.equal(matches(allowPattern, "https://api.example.com/login"), false);
  assert.deepEqual(new Set(rules.map((rule) => rule.id)).size, rules.length);
});

test("returns no rules without origins and deduplicates repeated origins", () => {
  assert.deepEqual(buildProtectionRules([], ["/login"]), []);
  assert.deepEqual(buildProtectionRules(["", null], []), []);
  assert.equal(buildProtectionRules(["https://example.com", "https://example.com"], []).length, 1);
});
