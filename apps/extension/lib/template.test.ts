import { describe, expect, it } from "vitest";
import { createProject } from "./project-workspace";
import { resolveTemplate, resolveUrlTemplate } from "./template";

describe("template resolution", () => {
  it("encodes variables inserted into URLs", () => {
    const project = createProject("模板项目");
    project.variables = [{ key: "tenant", value: "华东 / A" }];
    const page = { ...project.pages[0]!, url: "https://example.com/app?tenant={{project.tenant}}&role={{role}}" };
    expect(resolveUrlTemplate(page.url, project, page)).toEqual({
      ok: true,
      value: `https://example.com/app?tenant=${encodeURIComponent("华东 / A")}&role=${encodeURIComponent(page.role)}`
    });
  });

  it("reports unknown variables instead of leaving placeholders", () => {
    const project = createProject("模板项目");
    const page = project.pages[0]!;
    expect(resolveTemplate("客户：{{project.customer}}", project, page)).toEqual({
      ok: false,
      errors: ["未定义变量：project.customer"]
    });
  });

  it("escapes Markdown syntax in display values", () => {
    const project = createProject("模板项目");
    project.variables = [{ key: "customer", value: "**重点**" }];
    const page = project.pages[0]!;
    expect(resolveTemplate("客户：{{project.customer}}", project, page, "markdown")).toEqual({ ok: true, value: "客户：\\*\\*重点\\*\\*" });
    expect(resolveTemplate("客户：{{project.customer}}", project, page)).toEqual({ ok: true, value: "客户：**重点**" });
  });

  it("reports line numbers for Markdown template errors", () => {
    const project = createProject("模板项目");
    const page = project.pages[0]!;
    expect(resolveTemplate("# 标题\n客户：{{project.missing}}", project, page, "markdown")).toEqual({
      ok: false,
      errors: ["第 2 行：未定义变量：project.missing"]
    });
    expect(resolveTemplate("# 标题\n{{project.customer", project, page, "markdown")).toEqual({
      ok: false,
      errors: ["第 2 行：模板包含不完整的变量占位符。"]
    });
  });

  it("exposes built-in page tokens and keeps them reserved over page variables", () => {
    const project = createProject("模板项目");
    const page = project.pages[0]!;
    page.url = "https://example.com/orders?tenant=acme";
    page.variables = [{ key: "url", value: "变量值" }];
    expect(resolveTemplate("{{page.url}} · {{page.businessLabel}} · {{page.title}}", project, page)).toEqual({
      ok: true,
      value: `https://example.com/orders?tenant=acme · ${page.businessLabel} · ${page.title}`
    });
  });
});
