import { describe, expect, it } from "vitest";
import { canCacheAudienceSnapshot, createAudienceEventGuard } from "./audience-sync";
import { sampleProject, sampleSession } from "./sample-project";

describe("audience event guard", () => {
  it("rejects wrong sessions, duplicate nonces and stale snapshots", () => {
    const accepts = createAudienceEventGuard("session-valid");
    const snapshot = { type: "snapshot" as const, sessionId: "session-valid", seq: 2, nonce: "nonce-12345678", at: Date.now(), project: sampleProject, session: { ...sampleSession, id: "session-valid", sequence: 2 } };
    expect(accepts(snapshot)).toBe(true);
    expect(accepts(snapshot)).toBe(false);
    expect(accepts({ ...snapshot, nonce: "nonce-abcdefgh", seq: 1 })).toBe(false);
    expect(accepts({ ...snapshot, nonce: "nonce-ijklmnop", seq: 3, sessionId: "session-other" })).toBe(false);
  });
});

describe("audience snapshot cache", () => {
  it("does not put oversized presentation assets into localStorage", () => {
    expect(canCacheAudienceSnapshot({ content: "x".repeat(1_500_001) })).toBe(false);
    expect(canCacheAudienceSnapshot({ content: "x".repeat(1_000) })).toBe(true);
  });
});
