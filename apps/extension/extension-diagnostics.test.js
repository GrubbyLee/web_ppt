import test from "node:test";
import assert from "node:assert/strict";
import { redactExtensionDiagnostic } from "./extension-diagnostics.js";

test("extension diagnostics remove credentials, quoted secrets and business URLs", () => {
  const value = redactExtensionDiagnostic('Bearer abc.def password=hunter2 "access_token":"private" https://example.com/app/customer/42?token=secret-value');
  assert.match(value, /\[REDACTED_CREDENTIAL\]/);
  assert.match(value, /password=\[REDACTED\]/);
  assert.match(value, /\[REDACTED_URL\]/);
  assert.doesNotMatch(value, /hunter2|private|secret-value|abc\.def|example\.com|customer\/42/);
});
