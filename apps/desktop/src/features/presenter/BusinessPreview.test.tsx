import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PresentationPage, Project } from "@showit/contracts";
import { sampleProject } from "../../lib/sample-project";
import { BusinessPreview } from "./BusinessPreview";

describe("BusinessPreview", () => {
  it("renders project configuration without demo-only business content", () => {
    const sourcePage = sampleProject.pages[0];
    const sourceConnector = sampleProject.connectors[0];
    if (!sourcePage || !sourceConnector) throw new Error("sample project fixture is incomplete");
    const page: PresentationPage = {
      ...sourcePage,
      id: "customer-page",
      title: "客户工作区",
      section: "销售演示",
      role: "客户经理",
      businessLabel: "客户概览",
      purpose: "展示客户项目的实时状态。",
      url: "https://demo.example.com/customers",
      connectorId: "customer-connector"
    };
    const project: Project = {
      ...sampleProject,
      id: "customer-project",
      name: "Northwind Demo",
      brand: { ...sampleProject.brand, loadingMessage: "正在准备客户画面" },
      pages: [page],
      connectors: [{
        ...sourceConnector,
        id: "customer-connector",
        name: "客户演示连接器",
        origin: "https://demo.example.com",
        allowedOrigins: ["https://demo.example.com"]
      }]
    };

    render(<BusinessPreview project={project} page={page} />);

    expect(screen.getByText("Northwind Demo", { selector: "small" })).toBeVisible();
    expect(screen.getByText("客户概览", { selector: "h2" })).toBeVisible();
    expect(screen.getAllByText("https://demo.example.com")).toHaveLength(2);
    expect(screen.queryByText("林伟")).not.toBeInTheDocument();
    expect(screen.queryByText("12,842")).not.toBeInTheDocument();
    expect(screen.queryByText(/LCAPIM/)).not.toBeInTheDocument();
  });
});
