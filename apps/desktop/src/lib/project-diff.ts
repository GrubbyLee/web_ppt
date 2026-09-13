import type { Project } from "@showit/contracts";

export type ProjectDifference = {
  id: string;
  area: "项目" | "页面" | "脚本" | "连接器";
  message: string;
};

export function diffProjects(previous: Project, current: Project): ProjectDifference[] {
  const differences: ProjectDifference[] = [];
  if (previous.name !== current.name) differences.push({ id: "project-name", area: "项目", message: "项目名称已修改" });
  if (previous.description !== current.description) differences.push({ id: "project-description", area: "项目", message: "项目说明已修改" });
  if (JSON.stringify(previous.layout) !== JSON.stringify(current.layout)) differences.push({ id: "project-layout", area: "项目", message: "默认布局已修改" });
  if (JSON.stringify(previous.variables) !== JSON.stringify(current.variables)) differences.push({ id: "project-variables", area: "项目", message: "项目变量已修改" });

  const previousPages = new Map(previous.pages.map((page) => [page.id, page]));
  const currentPages = new Map(current.pages.map((page) => [page.id, page]));
  for (const page of current.pages) {
    const oldPage = previousPages.get(page.id);
    if (!oldPage) {
      differences.push({ id: `page-added-${page.id}`, area: "页面", message: `新增页面：${page.title}` });
      continue;
    }
    if (oldPage.order !== page.order) differences.push({ id: `page-order-${page.id}`, area: "页面", message: `${page.title}：顺序已调整` });
    if (oldPage.title !== page.title || oldPage.section !== page.section || oldPage.purpose !== page.purpose || oldPage.role !== page.role) {
      differences.push({ id: `page-meta-${page.id}`, area: "页面", message: `${page.title}：页面信息已修改` });
    }
    if (oldPage.url !== page.url || oldPage.fallbackUrl !== page.fallbackUrl || oldPage.connectorId !== page.connectorId || JSON.stringify(oldPage.variables) !== JSON.stringify(page.variables)) {
      differences.push({ id: `page-source-${page.id}`, area: "页面", message: `${page.title}：业务来源或变量已修改` });
    }
    if (oldPage.script.markdown !== page.script.markdown || JSON.stringify(oldPage.script.steps) !== JSON.stringify(page.script.steps)) {
      differences.push({ id: `script-${page.id}`, area: "脚本", message: `${page.title}：讲解脚本已修改` });
    }
  }
  for (const page of previous.pages) {
    if (!currentPages.has(page.id)) differences.push({ id: `page-removed-${page.id}`, area: "页面", message: `删除页面：${page.title}` });
  }
  if (JSON.stringify(previous.connectors) !== JSON.stringify(current.connectors)) differences.push({ id: "connectors", area: "连接器", message: "连接器配置已修改" });
  return differences;
}
