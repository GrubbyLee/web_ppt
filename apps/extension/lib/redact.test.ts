import { describe, expect, it } from "vitest";
import { redactExtensionDiagnostic } from "./redact";

describe("extension diagnostics redaction", () => {
  it("removes credentials, quoted secrets and business URLs", () => {
    const value = redactExtensionDiagnostic('Bearer abc.def password=hunter2 "access_token":"private" https://example.com/app/customer/42?token=secret-value');
    expect(value).toMatch(/\[REDACTED_CREDENTIAL\]/);
    expect(value).toMatch(/password=\[REDACTED\]/);
    expect(value).toMatch(/\[REDACTED_URL\]/);
    expect(value).not.toMatch(/hunter2|private|secret-value|abc\.def|example\.com|customer\/42/);
  });
});
