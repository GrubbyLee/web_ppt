import { describe, expect, it } from "vitest";
import { sanitizeSignalMessage } from "../src/signal";

describe("signal message sanitation", () => {
  it("forwards well-formed signaling envelopes", () => {
    expect(sanitizeSignalMessage({ type: "join", from: "peer-1", displayName: "观众" })).toEqual({ type: "join", from: "peer-1", displayName: "观众" });
    expect(sanitizeSignalMessage({ type: "offer", to: "peer-1", from: "publisher", description: { type: "offer", sdp: "v=0" } })).toBeTruthy();
    expect(sanitizeSignalMessage({ type: "ice", to: "peer-1", from: "publisher", candidate: { candidate: "candidate:1" } })).toBeTruthy();
    expect(sanitizeSignalMessage({ type: "leave", from: "peer-1" })).toEqual({ type: "leave", from: "peer-1" });
  });

  it("rejects oversized or malformed payloads", () => {
    expect(sanitizeSignalMessage(null)).toBeNull();
    expect(sanitizeSignalMessage("join")).toBeNull();
    expect(sanitizeSignalMessage({ type: "unknown", from: "peer" })).toBeNull();
    expect(sanitizeSignalMessage({ type: "join", from: "x".repeat(200) })).toBeNull();
    const oversizedSdp = { type: "offer", to: "p", from: "pub", description: { type: "offer", sdp: "x".repeat(200_000) } };
    expect(sanitizeSignalMessage(oversizedSdp)).toBeNull();
  });
});
