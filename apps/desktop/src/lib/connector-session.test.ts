import { describe, expect, it, vi } from "vitest";
import { sampleProject } from "./sample-project";
import { probeConnectorSession, supportsConnectorSessionProbe } from "./connector-session";

describe("connector session probe", () => {
  const connector = sampleProject.connectors[0]!;

  it("reads session fields and role mappings from connector configuration", async () => {
    const response = (user: unknown) => vi.fn(async () => new Response(JSON.stringify({ data: { user } }), { status: 200 }));
    await expect(probeConnectorSession("http://localhost:4173/console/", "访客", connector, response(null) as typeof fetch)).resolves.toMatchObject({ state: "anonymous" });
    await expect(probeConnectorSession("http://localhost:4173/console/", "能力运营者", connector, response({ role: "operator", roles: [] }) as typeof fetch)).resolves.toEqual({ state: "ready", role: "operator" });
    await expect(probeConnectorSession("http://localhost:4173/console/", "系统管理员", connector, response({ role: "guest", roles: [] }) as typeof fetch)).resolves.toMatchObject({ state: "role-mismatch", role: "guest" });
  });

  it("is enabled only through connector configuration", () => {
    expect(supportsConnectorSessionProbe(connector)).toBe(true);
    expect(supportsConnectorSessionProbe({ ...connector, sessionProbe: undefined })).toBe(false);
  });

  it("supports a different response shape without product-specific code", async () => {
    const generic = {
      ...connector,
      sessionProbe: {
        path: "/auth/me",
        userPath: ["account"],
        primaryRoleField: "kind",
        rolesField: "permissions",
        roleMappings: [{ presentationRole: "审核员", connectorRole: "reviewer" }]
      }
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ account: { kind: "member", permissions: ["reviewer"] } }), { status: 200 }));
    await expect(probeConnectorSession("https://product.example/console", "审核员", generic, fetcher as typeof fetch)).resolves.toEqual({ state: "ready", role: "member" });
    expect(fetcher).toHaveBeenCalledWith(new URL("https://product.example/auth/me"), expect.objectContaining({ credentials: "include" }));
  });
});
