import { describe, expect, it } from "vitest";
import { ProjectSchema } from "@showit/contracts";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createProject, createProjectPackage, duplicateProject, normalizeProject, parseProjectPackage } from "./project-workspace";

describe("project workspace helpers", () => {
  it("creates a valid editable project", () => {
    const project = createProject("客户演示");
    expect(ProjectSchema.safeParse(project).success).toBe(true);
    expect(project.pages).toHaveLength(1);
    expect(project.status).toBe("draft");
  });

  it("duplicates project, page and step identities", () => {
    const source = createProject("原项目");
    const duplicate = duplicateProject(source);
    expect(duplicate.id).not.toBe(source.id);
    expect(duplicate.pages[0]?.id).not.toBe(source.pages[0]?.id);
    expect(duplicate.pages[0]?.script.steps[0]?.id).not.toBe(source.pages[0]?.script.steps[0]?.id);
    expect(duplicate.name).toContain("副本");
  });

  it("deep-copies nested structures and re-keys connector and mask identities", () => {
    const source = createProject("深拷贝项目");
    source.connectors.push({
      id: "connector-src",
      name: "业务控制台",
      origin: "https://example.com",
      mode: "extension",
      permission: "assist",
      securityMode: "interactive",
      environment: "默认环境",
      requestHeaders: [{ name: "X-Trace", value: "abc" }],
      basicAuthInstructions: "",
      loginPaths: ["/login"],
      logoutPaths: ["/logout"],
      roleSwitchPaths: [],
      sandboxPermissions: ["allow-scripts", "allow-same-origin"],
      allowedOrigins: ["https://example.com"],
      sessionProbe: { path: "/api/me", userPath: ["data", "user"], primaryRoleField: "role", rolesField: "roles", roleMappings: [{ presentationRole: "presenter", connectorRole: "admin" }] }
    });
    const connector = source.connectors[0]!;
    source.pages[0]!.connectorId = connector.id;
    source.pages[0]!.privacyMasks = [{ id: "mask-keep", x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.4, mode: "solid", locator: { strategy: "id", value: "balance" } }];
    source.pages[0]!.variables = [{ key: "tier", value: "vip" }];
    source.pages[0]!.offline = { kind: "html", content: "<p>备用</p>", allowedNetworkOrigins: ["https://api.example.com"] };
    source.variables = [{ key: "region", value: "cn" }];

    const duplicate = duplicateProject(source);
    expect(duplicate.connectors).toHaveLength(1);
    expect(duplicate.connectors[0]!.id).not.toBe(connector.id);
    expect(duplicate.pages[0]!.connectorId).not.toBe(connector.id);
    expect(duplicate.connectors.find((item) => item.id === duplicate.pages[0]!.connectorId)?.name).toBe(connector.name);

    const page = duplicate.pages[0]!;
    expect(page.privacyMasks[0]!.id).not.toBe("mask-keep");
    expect(page.privacyMasks[0]).not.toBe(source.pages[0]!.privacyMasks[0]);
    expect(page.variables[0]).not.toBe(source.pages[0]!.variables[0]);
    expect(page.offline).not.toBe(source.pages[0]!.offline);
    expect(duplicate.connectors[0]!.requestHeaders[0]).not.toBe(connector.requestHeaders[0]);
    expect(duplicate.connectors[0]!.sessionProbe?.roleMappings[0]).not.toBe(connector.sessionProbe?.roleMappings[0]);
    expect(duplicate.variables[0]).not.toBe(source.variables[0]);

    // Mutating the duplicate must not leak back into the source project.
    page.privacyMasks[0]!.x1 = 0.9;
    expect(source.pages[0]!.privacyMasks[0]!.x1).toBe(0.1);
    expect(ProjectSchema.safeParse(duplicate).success).toBe(true);
  });

  it("normalizes page order and planned duration", () => {
    const project = createProject("顺序测试");
    const second = { ...project.pages[0]!, id: "page-second", order: 8, estimatedSeconds: 30 };
    const normalized = normalizeProject({ ...project, pages: [{ ...project.pages[0]!, order: 9 }, second] });
    expect(normalized.pages.map((page) => page.order)).toEqual([0, 1]);
    expect(normalized.totalPlannedSeconds).toBe(project.pages[0]!.estimatedSeconds + 30);
  });

  it("round-trips a checksummed .showit project package", async () => {
    const project = createProject("导入导出");
    project.brand.logoDataUrl = "data:image/png;base64,AA==";
    project.pages[0]!.offline = { kind: "html", content: "<main>离线内容</main><script src=\"app.js\"></script>", resources: [{ path: "app.js", dataUrl: "data:application/javascript;base64,d2luZG93LnJlYWR5PXRydWU=" }], allowedNetworkOrigins: ["https://api.example.com"] };
    const packageData = await createProjectPackage(project);
    const files = unzipSync(packageData);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["manifest.json", "pages.json", `scripts/${project.pages[0]?.id}.md`, `offline/${project.pages[0]?.id}/index.html`, `offline/${project.pages[0]?.id}/resources/app.js`, "assets/logo.png"]));
    expect(JSON.parse(strFromU8(files["manifest.json"]!))).toMatchObject({ packageVersion: 3, encryption: "none" });
    const restored = await parseProjectPackage(packageData);
    expect(restored).toEqual(project);
  });

  it("rejects malformed and modified project packages", async () => {
    await expect(parseProjectPackage('{"kind":"showit-project","project":{"name":"broken"}}')).rejects.toThrow();
    const project = createProject("完整性");
    const packageData = await createProjectPackage(project);
    const files = unzipSync(packageData);
    files["pages.json"] = strToU8('{"pages":[]}');
    await expect(parseProjectPackage(zipSync(files))).rejects.toThrow("完整性校验失败");
  });

  it("encrypts packages and rejects a wrong password", async () => {
    const project = createProject("加密项目");
    const packageData = await createProjectPackage(project, "correct horse battery staple");
    const manifest = JSON.parse(strFromU8(unzipSync(packageData)["manifest.json"]!));
    expect(manifest).toMatchObject({ packageVersion: 3, encryption: "argon2id-aes-256-gcm", kdf: { memoryKiB: 65_536, iterations: 3 } });
    expect(JSON.stringify(manifest)).not.toContain(project.name);
    await expect(parseProjectPackage(packageData)).rejects.toThrow("需要输入密码");
    await expect(parseProjectPackage(packageData, "wrong password")).rejects.toThrow("密码错误");
    await expect(parseProjectPackage(packageData, "correct horse battery staple")).resolves.toEqual(project);
  });

  it("imports legacy v1 packages", async () => {
    const project = createProject("旧项目");
    await expect(parseProjectPackage(JSON.stringify({ kind: "showit-project", packageVersion: 1, exportedAt: new Date().toISOString(), project }))).resolves.toEqual(project);
  });
});
