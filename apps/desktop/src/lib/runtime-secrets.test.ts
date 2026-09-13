import { afterEach, describe, expect, it } from "vitest";
import { clearRuntimeSecrets, getRuntimeSecret, hasRuntimeSecretSession, missingRuntimeSecrets, setRuntimeSecrets } from "./runtime-secrets";

const definitions = [
  { key: "apiToken", label: "API Token", required: true, expiresAfterMinutes: 1 },
  { key: "optionalPin", label: "临时 PIN", required: false, expiresAfterMinutes: 2 }
];

describe("runtime secrets", () => {
  afterEach(() => clearRuntimeSecrets());

  it("keeps values in an in-memory session and expires them", () => {
    setRuntimeSecrets("session-a", definitions, { apiToken: "top-secret" }, 1_000);
    expect(getRuntimeSecret("session-a", "apiToken", 60_999)).toBe("top-secret");
    expect(getRuntimeSecret("session-a", "apiToken", 61_000)).toBeNull();
    expect(hasRuntimeSecretSession("session-a")).toBe(false);
  });

  it("reports required values and wipes a session explicitly", () => {
    expect(missingRuntimeSecrets("session-a", definitions)).toHaveLength(1);
    setRuntimeSecrets("session-a", definitions, { apiToken: "value", optionalPin: "1234" });
    expect(missingRuntimeSecrets("session-a", definitions)).toEqual([]);
    clearRuntimeSecrets("session-a");
    expect(getRuntimeSecret("session-a", "apiToken")).toBeNull();
  });

  it("rejects a missing required value", () => {
    expect(() => setRuntimeSecrets("session-a", definitions, {})).toThrow("不能为空");
  });
});
