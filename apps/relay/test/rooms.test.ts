import { describe, expect, it } from "vitest";
import { RelayError, RoomStore } from "../src/rooms";

function createStore() {
  return new RoomStore();
}

describe("room store", () => {
  it("creates rooms with unguessable codes and distinct tokens", () => {
    const store = createStore();
    const a = store.createRoom({ baseUrl: "http://127.0.0.1:8787", capacity: "p2p", joinMode: "direct" });
    const b = store.createRoom({ baseUrl: "http://127.0.0.1:8787", capacity: "p2p", joinMode: "direct" });
    expect(a.roomCode).not.toBe(b.roomCode);
    expect(a.presenterToken).not.toBe(b.presenterToken);
    expect(a.viewerUrl).toBe(`http://127.0.0.1:8787/watch/${a.roomCode}`);
    expect(a.signalUrl).toBe(`http://127.0.0.1:8787/signal/${a.roomCode}`);
  });

  it("resolves rooms by presenter token but not by forged tokens", () => {
    const store = createStore();
    const room = store.createRoom({ baseUrl: "http://x", capacity: "p2p", joinMode: "direct" });
    expect(store.roomByPresenterToken(room.presenterToken)?.roomCode).toBe(room.roomCode);
    expect(store.roomByPresenterToken("forged")).toBeNull();
  });

  it("verifies viewer tokens exactly and rejects after the room ends", () => {
    const store = createStore();
    const summary = store.createRoom({ baseUrl: "http://x", capacity: "p2p", joinMode: "direct" });
    const room = store.roomByPresenterToken(summary.presenterToken)!;
    const viewerToken = summary.presenterToken === undefined ? "" : room.viewerToken;
    expect(store.verifyViewerToken(room.roomCode, viewerToken)?.roomCode).toBe(room.roomCode);
    expect(store.verifyViewerToken(room.roomCode, viewerToken.slice(0, -1) + "x")).toBeNull();
    store.endRoom(room);
    expect(store.verifyViewerToken(room.roomCode, viewerToken)).toBeNull();
  });

  it("enforces the viewer cap and join modes", () => {
    const store = createStore();
    const summary = store.createRoom({ baseUrl: "http://x", capacity: "p2p", joinMode: "approval" });
    const room = store.roomByPresenterToken(summary.presenterToken)!;
    const first = store.registerViewer(room, "v1", "观众一", "peer-1");
    expect("error" in first ? first.error : first.status).toBe("pending");
    expect(store.decideViewer(room, "v1", true)).toBe(true);
    expect(room.viewers.get("v1")?.status).toBe("approved");

    for (let index = 2; index <= 21; index += 1) {
      store.registerViewer(room, `v${index}`, `观众${index}`, `peer-${index}`);
    }
    const overflow = store.registerViewer(room, "v22", "溢出", "peer-22");
    expect("error" in overflow).toBe(true);
  });

  it("evicts idle rooms only", () => {
    const store = createStore();
    const summary = store.createRoom({ baseUrl: "http://x", capacity: "p2p", joinMode: "direct" });
    const room = store.roomByPresenterToken(summary.presenterToken)!;
    store.touch(room, new Date(Date.now() - 20 * 60 * 1_000));
    const fresh = store.createRoom({ baseUrl: "http://x", capacity: "p2p", joinMode: "direct" });
    expect(store.evictIdleRooms(new Date())).toBe(1);
    expect(store.roomByCode(summary.roomCode)).toBeNull();
    expect(store.roomByPresenterToken(fresh.presenterToken)).not.toBeNull();
  });

  it("rejects room creation once active rooms reach the cap", () => {
    const store = createStore();
    for (let index = 0; index < 64; index += 1) {
      store.createRoom({ baseUrl: "http://x", capacity: "p2p", joinMode: "direct" });
    }
    expect(() => store.createRoom({ baseUrl: "http://x", capacity: "p2p", joinMode: "direct" })).toThrow(RelayError);
  });

  it("frees capacity by evicting idle rooms, not active ones", () => {
    const store = createStore();
    const stale: string[] = [];
    for (let index = 0; index < 64; index += 1) {
      const room = store.createRoom({ baseUrl: "http://x", capacity: "p2p", joinMode: "direct" });
      if (index % 2 === 0) stale.push(room.roomCode);
    }
    for (const code of stale) {
      store.touch(store.roomByCode(code)!, new Date(Date.now() - 20 * 60 * 1_000));
    }
    const fresh = store.createRoom({ baseUrl: "http://x", capacity: "p2p", joinMode: "direct" });
    expect(fresh.roomCode).toHaveLength(8);
    expect(store.roomByCode(stale[0]!)).toBeNull();
  });
});
