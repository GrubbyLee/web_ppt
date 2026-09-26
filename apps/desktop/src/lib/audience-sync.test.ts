import { describe, expect, it } from "vitest";
import { createAudienceEventGuard, laserOnlyChange } from "./audience-sync";
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

  it("accepts a restarted presenter after bye or a large sequence reset", () => {
    const accepts = createAudienceEventGuard("session-valid");
    const snapshot = (seq: number, nonce: string) => ({ type: "snapshot" as const, sessionId: "session-valid", seq, nonce, at: Date.now(), project: sampleProject, session: { ...sampleSession, id: "session-valid", sequence: seq } });
    expect(accepts(snapshot(200, "nonce-run1-a"))).toBe(true);
    expect(accepts({ type: "bye" as const, sessionId: "session-valid", seq: 200, nonce: "nonce-run1-bye", at: Date.now() })).toBe(true);
    expect(accepts(snapshot(1, "nonce-run2-a"))).toBe(true);

    const crashGuard = createAudienceEventGuard("session-valid");
    expect(crashGuard(snapshot(300, "nonce-run3-a"))).toBe(true);
    expect(crashGuard(snapshot(2, "nonce-run4-a"))).toBe(true);
    expect(crashGuard(snapshot(2, "nonce-run4-b"))).toBe(false);
  });
});

describe("laser delta detection", () => {
  it("publishes a laser delta when only the pointer moved", () => {
    const previous = { ...sampleSession, sequence: 7, laser: { x: 0.1, y: 0.2, expiresAt: 1 } };
    const moved = { ...previous, sequence: 8, laser: { x: 0.3, y: 0.4, expiresAt: 2 } };
    expect(laserOnlyChange(previous, moved)).toEqual({ x: 0.3, y: 0.4, expiresAt: 2 });
    expect(laserOnlyChange(moved, { ...moved, sequence: 9, laser: null })).toBeNull();
  });

  it("falls back to a full snapshot for any other session change", () => {
    const previous = { ...sampleSession, sequence: 7, laser: { x: 0.1, y: 0.2, expiresAt: 1 } };
    expect(laserOnlyChange(previous, { ...previous, sequence: 8, laser: { x: 0.3, y: 0.4, expiresAt: 2 }, currentPageIndex: 3 })).toBeUndefined();
    expect(laserOnlyChange(previous, { ...previous, sequence: 8, laser: { x: 0.3, y: 0.4, expiresAt: 2 }, circles: [{ id: "circle-1", x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 }] })).toBeUndefined();
    const unchanged = { ...previous, sequence: 8 };
    expect(laserOnlyChange(previous, unchanged)).toBeUndefined();
  });
});
