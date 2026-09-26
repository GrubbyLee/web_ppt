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
  if (previous.autoAdvanceEnabled !== current.autoAdvanceEnabled || previous.autoAdvanceSeconds !== current.autoAdvanceSeconds) {
    differences.push({ id: "project-auto-advance", area: "项目", message: "自动翻页设置已修改" });
  }
  if (previous.audienceJoinMode !== current.audienceJoinMode || previous.audienceCapacityMode !== current.audienceCapacityMode || previous.browserSessionMode !== current.browserSessionMode) {
    differences.push({ id: "project-audience", area: "项目", message: "观众或浏览器会话设置已修改" });
  }
  if (JSON.stringify(previous.variables) !== JSON.stringify(current.variables)) differences.push({ id: "project-variables", area: "项目", message: "项目变量已修改" });
  if (JSON.stringify(previous.sensitiveVariables) !== JSON.stringify(current.sensitiveVariables)) differences.push({ id: "project-sensitive-variables", area: "项目", message: "敏感变量定义已修改" });
  if (JSON.stringify(previous.brand) !== JSON.stringify(current.brand)) differences.push({ id: "project-brand", area: "项目", message: "品牌外观已修改" });

  const previousPages = new Map(previous.pages.map((page) => [page.id, page]));
  const currentPages = new Map(current.pages.map((page) => [page.id, page]));
  for (const page of current.pages) {
    const oldPage = previousPages.get(page.id);
    if (!oldPage) {
      differences.push({ id: `page-added-${page.id}`, area: "页面", message: `新增页面：${page.title}` });
      continue;
    }
    if (oldPage.order !== page.order) differences.push({ id: `page-order-${page.id}`, area: "页面", message: `${page.title}：顺序已调整` });
    if (oldPage.enabled !== page.enabled) differences.push({ id: `page-enabled-${page.id}`, area: "页面", message: `${page.title}：${page.enabled ? "已启用" : "已停用"}` });
    if (oldPage.title !== page.title || oldPage.section !== page.section || oldPage.purpose !== page.purpose || oldPage.role !== page.role || oldPage.businessLabel !== page.businessLabel || JSON.stringify(oldPage.tags) !== JSON.stringify(page.tags) || oldPage.transitionNote !== page.transitionNote || oldPage.errorHandling !== page.errorHandling) {
      differences.push({ id: `page-meta-${page.id}`, area: "页面", message: `${page.title}：页面信息已修改` });
    }
    if (oldPage.url !== page.url || oldPage.fallbackUrl !== page.fallbackUrl || oldPage.connectorId !== page.connectorId || JSON.stringify(oldPage.variables) !== JSON.stringify(page.variables)) {
      differences.push({ id: `page-source-${page.id}`, area: "页面", message: `${page.title}：业务来源或变量已修改` });
    }
    if (oldPage.estimatedSeconds !== page.estimatedSeconds || oldPage.autoAdvanceSeconds !== page.autoAdvanceSeconds) {
      differences.push({ id: `page-duration-${page.id}`, area: "页面", message: `${page.title}：时长或自动翻页已修改` });
    }
    if (JSON.stringify(oldPage.privacyMasks) !== JSON.stringify(page.privacyMasks)) {
      differences.push({ id: `page-masks-${page.id}`, area: "页面", message: `${page.title}：隐私遮罩已修改` });
    }
    if (JSON.stringify(oldPage.offline) !== JSON.stringify(page.offline)) {
      differences.push({ id: `page-offline-${page.id}`, area: "页面", message: `${page.title}：离线备用内容已修改` });
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
