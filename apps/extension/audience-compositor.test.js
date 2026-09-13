import assert from "node:assert/strict";
import test from "node:test";
import { resolveAudienceFrameMode, sanitizeAudienceMasks } from "./audience-compositor.js";

test("audience compositor accepts only bounded mask geometry", () => {
  assert.deepEqual(sanitizeAudienceMasks([
    { id: "not-forwarded", x1: -1, y1: 0.2, x2: 2, y2: 0.8, mode: "blur", locator: { value: "private-field" } },
    { x1: 0, y1: Number.NaN, x2: 1, y2: 1, mode: "solid" }
  ]), [{ x1: 0, y1: 0.2, x2: 1, y2: 0.8, mode: "blur" }]);
});

test("audience compositor fails closed for unknown and offline states", () => {
  assert.equal(resolveAudienceFrameMode({ screenMode: "normal" }), "normal");
  assert.equal(resolveAudienceFrameMode({ screenMode: "unknown" }), "privacy");
  assert.equal(resolveAudienceFrameMode({ screenMode: "normal", offlineFallbackActive: true }), "privacy");
});
