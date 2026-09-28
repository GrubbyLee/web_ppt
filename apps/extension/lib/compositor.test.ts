import { describe, expect, it } from "vitest";
import { resolveAudienceFrameMode, sanitizeAudienceMasks } from "./compositor";

describe("audience compositor", () => {
  it("accepts only bounded mask geometry", () => {
    expect(sanitizeAudienceMasks([
      { id: "not-forwarded", x1: -1, y1: 0.2, x2: 2, y2: 0.8, mode: "blur", locator: { value: "private-field" } },
      { x1: 0, y1: Number.NaN, x2: 1, y2: 1, mode: "solid" }
    ])).toEqual([{ x1: 0, y1: 0.2, x2: 1, y2: 0.8, mode: "blur" }]);
  });

  it("fails closed for unknown and offline states", () => {
    expect(resolveAudienceFrameMode({ screenMode: "normal" })).toBe("normal");
    expect(resolveAudienceFrameMode({ screenMode: "unknown" })).toBe("privacy");
    expect(resolveAudienceFrameMode({ screenMode: "normal", offlineFallbackActive: true })).toBe("privacy");
  });
});
