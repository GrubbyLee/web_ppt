import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "./export";

describe("export redaction", () => {
  it("removes secrets from scripts and URLs", () => {
    const input = "token=abc123\nAuthorization: Bearer abc.def\nhttps://example.com/?api_key=secret";
    const result = redactSensitiveText(input);
    expect(result).not.toContain("abc123");
    expect(result).not.toContain("abc.def");
    expect(result).not.toContain("secret");
    expect(result).toContain("[REDACTED]");
  });

  it("removes quoted JSON values, cookies and Basic credentials", () => {
    const input = '{"access_token":"secret-value","client_secret":"another-secret"} Cookie: session=private-value Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==';
    const result = redactSensitiveText(input);
    expect(result).not.toContain("secret-value");
    expect(result).not.toContain("another-secret");
    expect(result).not.toContain("private-value");
    expect(result).not.toContain("QWxhZGRpbjpvcGVuIHNlc2FtZQ");
  });
});
