import { describe, expect, it } from "vitest";
import { buildProtectionRules, sanitizeProtectionPaths } from "./request-protection";

function allowPattern(origin: string, path: string): string {
  return buildProtectionRules(origin, [path])![1]!.condition.regexFilter;
}

function matches(pattern: string, url: string): boolean {
  // RE2 semantics: no lookahead, plain anchored match. Node's RegExp is a
  // superset, so a pattern free of lookarounds behaves identically here.
  return new RegExp(pattern).test(url);
}

describe("request protection", () => {
  it("sanitizes protection paths and rejects encoded or traversing entries", () => {
    expect(sanitizeProtectionPaths(["/login", "/login", "/sso/callback"])).toEqual(["/login", "/sso/callback"]);
    expect(sanitizeProtectionPaths(["login", "//evil.example/login", "/login?next=/admin", "/a/../login", "/login/%2e%2e/admin", "/login/%252e%252e/admin", "/login%2f..%2fadmin", 42, null])).toEqual([]);
  });

  it("allow rules cover the allowlisted path and its plain subpaths", () => {
    const pattern = allowPattern("https://example.com", "/login");
    expect(matches(pattern, "https://example.com/login")).toBe(true);
    expect(matches(pattern, "https://example.com/login/")).toBe(true);
    expect(matches(pattern, "https://example.com/login/callback")).toBe(true);
    expect(matches(pattern, "https://example.com/login?next=%2Fhome")).toBe(true);
    expect(matches(pattern, "https://example.com/login#fragment")).toBe(true);
    expect(matches(pattern, "https://example.com/loginx")).toBe(false);
    expect(matches(pattern, "https://evil.example/login")).toBe(false);
  });

  it("allow rules do not cover double-encoded traversal or sibling prefixes", () => {
    const pattern = allowPattern("https://example.com", "/login");
    expect(matches(pattern, "https://example.com/login/%252e%252e/orders")).toBe(false);
    expect(matches(pattern, "https://example.com/login/%2e%2e/orders")).toBe(false);
    expect(matches(pattern, "https://example.com/login/..%2forders")).toBe(false);
  });

  it("block rule covers websockets and every non-read-only method", () => {
    const [block] = buildProtectionRules("https://example.com", []);
    expect([...block!.condition.requestMethods].sort()).toEqual(["connect", "delete", "other", "patch", "post", "put"]);
    expect(block!.condition.resourceTypes).toContain("websocket");
  });

  it("blocks writes on every protected origin while auth paths stay main-origin only", () => {
    const rules = buildProtectionRules(["https://example.com", "https://api.example.com"], ["/login"]);
    const patterns = rules!.filter((rule) => rule.action.type === "block").map((rule) => rule.condition.regexFilter);
    expect(patterns.length).toBe(2);
    expect(patterns.some((pattern) => matches(pattern, "https://api.example.com/orders"))).toBe(true);
    expect(patterns.some((pattern) => matches(pattern, "https://example.com/orders"))).toBe(true);
    const allow = rules!.find((rule) => rule.action.type === "allow")!.condition.regexFilter;
    expect(matches(allow, "https://example.com/login")).toBe(true);
    expect(matches(allow, "https://api.example.com/login")).toBe(false);
    expect(new Set(rules!.map((rule) => rule.id)).size).toBe(rules!.length);
  });

  it("returns no rules without origins and deduplicates repeated origins", () => {
    expect(buildProtectionRules([], ["/login"])).toEqual([]);
    expect(buildProtectionRules(["", null], [])).toEqual([]);
    expect(buildProtectionRules(["https://example.com", "https://example.com"], [])!.length).toBe(1);
  });
});
