import { describe, expect, it } from "vitest";
import { captureHandoffDecision } from "./tab-handoff";

describe("capture handoff", () => {
  it("only follows a distinct authorized safe tab", () => {
    expect(captureHandoffDecision(1, 2, "https://system.example.com/page", true)).toBe("handoff");
    expect(captureHandoffDecision(1, 2, "https://login.example.com/sso", false)).toBe("authorize");
    expect(captureHandoffDecision(1, 1, "https://system.example.com/page", true)).toBe("ignore");
    expect(captureHandoffDecision(1, 2, "file:///etc/passwd", true)).toBe("block");
  });
});
