import { describe, expect, it } from "vitest";
import { sampleProject, sampleSession } from "../../lib/sample-project";
import { applyAudienceSnapshot, type AudienceState } from "./AudienceWindow";

function state(pageIndex: number, screenMode: typeof sampleSession.screenMode): AudienceState {
  return {
    project: structuredClone(sampleProject),
    session: { ...structuredClone(sampleSession), currentPageIndex: pageIndex, screenMode }
  };
}

describe("audience freeze snapshots", () => {
  it("accepts the first live snapshot even when the session is already frozen", () => {
    const frozen = state(3, "frozen");
    expect(applyAudienceSnapshot(state(0, "normal"), frozen, false)).toBe(frozen);
  });

  it("holds the visible page and annotations until the presenter unfreezes", () => {
    const visible = state(1, "normal");
    visible.session.circles = [{ id: "visible", x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 }];
    const entered = applyAudienceSnapshot(visible, state(1, "frozen"), true);
    const changedBehindFreeze = state(7, "frozen");
    changedBehindFreeze.session.circles = [];

    const held = applyAudienceSnapshot(entered, changedBehindFreeze, true);
    expect(held.session.currentPageIndex).toBe(1);
    expect(held.session.circles).toEqual(visible.session.circles);

    const resumed = state(7, "normal");
    expect(applyAudienceSnapshot(held, resumed, true)).toBe(resumed);
  });
});
