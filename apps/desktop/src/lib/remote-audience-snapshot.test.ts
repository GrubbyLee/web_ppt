import { describe, expect, it } from "vitest";
import { sampleProject, sampleSession } from "./sample-project";
import { createRemoteAudienceSnapshot } from "./remote-audience-snapshot";

describe("remote audience snapshot", () => {
  it("contains only display-safe state for the active page", () => {
    const project = structuredClone(sampleProject);
    const session = structuredClone(sampleSession);
    project.variables = [{ key: "tenant", value: "PRIVATE_PROJECT_VALUE" }];
    project.connectors[0]!.basicAuthInstructions = "PRIVATE_LOGIN_INSTRUCTIONS";
    project.pages[0]!.url = "https://example.com/private-customer";
    project.pages[0]!.script.markdown = "PRIVATE_PRESENTER_SCRIPT";
    project.pages[0]!.privacyMasks = [{ id: "mask-private", x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4, mode: "solid", locator: { strategy: "testid", value: "private-field" } }];
    session.currentPageIndex = 0;

    const snapshot = createRemoteAudienceSnapshot(project, session);
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.page).toEqual(expect.objectContaining({
      title: project.pages[0]!.title,
      privacyMasks: [{ x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4, mode: "solid" }]
    }));
    expect(snapshot.session.pageCount).toBe(project.pages.length);
    expect(serialized).not.toContain("PRIVATE_");
    expect(serialized).not.toContain("private-field");
    expect(snapshot.project).not.toHaveProperty("connectors");
    expect(snapshot.project).not.toHaveProperty("variables");
    expect(snapshot.page).not.toHaveProperty("script");
    expect(snapshot.page).not.toHaveProperty("url");
  });

  it("includes offline media only while the active fallback is displayed", () => {
    const project = structuredClone(sampleProject);
    const session = structuredClone(sampleSession);
    session.currentPageIndex = 0;
    project.pages[0]!.offline = { kind: "html", content: "<main>Audience fallback</main>", resources: [{ path: "private.js", dataUrl: "data:application/javascript;base64,c2VjcmV0" }], allowedNetworkOrigins: ["https://private.example.com"] };

    expect(createRemoteAudienceSnapshot(project, session).page).not.toHaveProperty("offline");
    session.offlineFallbackPageId = project.pages[0]!.id;
    expect(createRemoteAudienceSnapshot(project, session).page?.offline).toEqual({ kind: "html", content: "<main>Audience fallback</main>" });
  });
});
