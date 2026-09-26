import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleProject, sampleSession } from "./sample-project";
import { loadWorkspace, openAudienceWindow, resolveBrowserReadonlyProxyUrl } from "./persistence";
import { projectTrustState } from "./project-trust";

describe("browser development read-only proxy", () => {
  const connector = sampleProject.connectors[0]!;

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("translates the configured local business origin to the Showit origin", () => {
    expect(resolveBrowserReadonlyProxyUrl(
      connector,
      "http://localhost:3001/console/?view=approvals#queue",
      "http://localhost:4173",
      true
    )).toBe("http://localhost:4173/console/?view=approvals#queue");
  });

  it("does not proxy production or mismatched origins", () => {
    expect(resolveBrowserReadonlyProxyUrl(connector, "http://localhost:3001/console/", "http://localhost:4173", false)).toBeNull();
    expect(resolveBrowserReadonlyProxyUrl(connector, "https://example.com/console/", "http://localhost:4173", true)).toBeNull();
    expect(resolveBrowserReadonlyProxyUrl(connector, "not a url", "http://localhost:4173", true)).toBeNull();
    expect(resolveBrowserReadonlyProxyUrl({ ...connector, origin: "broken" }, "http://localhost:3001/console/", "http://localhost:4173", true)).toBeNull();
    expect(resolveBrowserReadonlyProxyUrl(connector, "http://localhost:3001/console/", "broken", true)).toBeNull();
  });

  it("reports when the browser blocks the audience popup", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    await expect(openAudienceWindow("session-test")).rejects.toThrow("弹出窗口");
  });

  it("migrates and trusts only the untouched persisted bundled sample", async () => {
    const legacy = structuredClone(sampleProject);
    legacy.connectors[0] = { ...legacy.connectors[0]!, origin: "http://localhost:3000", mode: "extension", allowedOrigins: ["http://localhost:3000"], loginPaths: ["/login", "/sso"], logoutPaths: ["/logout"], sessionProbe: undefined };
    legacy.pages = legacy.pages.map((page) => ({ ...page, pageType: page.id === "closing" ? "end" : "business", url: `http://localhost:3000/docs/demo/lc-apim-customer-demo/index.html?mode=presenter&showitPage=${page.id}` }));
    localStorage.setItem("showit:library:v1", JSON.stringify([{ project: legacy, session: sampleSession }]));

    const migrated = await loadWorkspace(sampleProject.id);

    expect(migrated?.project.pages[0]?.url).toBe("http://localhost:3001/console/?view=overview");
    expect(migrated?.project.pages.at(-1)?.pageType).toBe("business");
    expect(await projectTrustState(migrated!.project)).toBe("trusted");
  });
});
