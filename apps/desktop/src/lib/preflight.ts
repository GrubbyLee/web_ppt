import { ProjectSchema, type PresentationPage, type Project } from "@showit/contracts";
import { resolveTemplate, resolveUrlTemplate } from "./template";
import { isOfflineFallbackReady } from "./offline-fallback";
import { requestedOfflineOrigins } from "./offline-package";

export type PreflightState = "ok" | "warn" | "error";

export type PreflightItem = {
  id: string;
  state: PreflightState;
  message: string;
  pageId?: string;
};

export type PreflightReport = {
  items: PreflightItem[];
  errors: PreflightItem[];
  warnings: PreflightItem[];
  canPublish: boolean;
};

function duplicateKeys(values: Array<{ key: string }>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value.key)) duplicates.add(value.key);
    seen.add(value.key);
  }
  return [...duplicates];
}

function normalizedOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function addTemplateResult(
  items: PreflightItem[],
  page: PresentationPage,
  id: string,
  label: string,
  result: ReturnType<typeof resolveTemplate>
): void {
  if (!result.ok) {
    items.push({ id, state: "error", pageId: page.id, message: `${page.title}：${label}${result.errors.join("；")}` });
  }
}

export function runProjectPreflight(project: Project): PreflightReport {
  const items: PreflightItem[] = [];
  const contract = ProjectSchema.safeParse(project);
  if (!contract.success) {
    for (const [index, issue] of contract.error.issues.entries()) {
      items.push({
        id: `contract-${index}`,
        state: "error",
        message: `${issue.path.join(".") || "项目"}：${issue.message}`
      });
    }
  }

  const projectDuplicates = duplicateKeys(project.variables);
  if (projectDuplicates.length > 0) {
    items.push({ id: "project-variable-duplicates", state: "error", message: `项目变量重复：${projectDuplicates.join("、")}` });
  }

  const sensitiveDuplicates = duplicateKeys(project.sensitiveVariables);
  if (sensitiveDuplicates.length > 0) {
    items.push({ id: "sensitive-variable-duplicates", state: "error", message: `敏感变量重复：${sensitiveDuplicates.join("、")}` });
  } else if (project.sensitiveVariables.length > 0) {
    items.push({ id: "sensitive-variables", state: "ok", message: `${project.sensitiveVariables.length} 个敏感变量将在演示启动时输入，并仅保存在当前进程内存。` });
  }

  const pageIds = new Set<string>();
  const connectorRoleMappings = new Map<string, Set<string>>();
  for (const connector of project.connectors) {
    const probe = connector.sessionProbe;
    if (!probe) continue;
    const presentationRoles = probe.roleMappings.map((mapping) => mapping.presentationRole);
    const duplicates = presentationRoles.filter((role, index) => presentationRoles.indexOf(role) !== index);
    if (duplicates.length > 0) {
      items.push({ id: `session-role-mapping-${connector.id}`, state: "error", message: `连接器“${connector.name}”的演示角色映射重复：${[...new Set(duplicates)].join("、")}。` });
    }
    connectorRoleMappings.set(connector.id, new Set(presentationRoles));
  }
  if (!project.pages.some((page) => page.enabled)) {
    items.push({ id: "pages-enabled", state: "error", message: "项目至少需要启用一个演示页面。" });
  }
  for (const [index, page] of project.pages.entries()) {
    if (pageIds.has(page.id)) items.push({ id: `page-id-${page.id}`, state: "error", pageId: page.id, message: `页面 ID 重复：${page.id}` });
    pageIds.add(page.id);
    if (!page.enabled) items.push({ id: `page-disabled-${page.id}`, state: "warn", pageId: page.id, message: `${page.title}：页面已禁用，运行演示时会跳过。` });
    if (page.order !== index) {
      items.push({ id: `page-order-${page.id}`, state: "error", pageId: page.id, message: `${page.title}：页面顺序应为 ${index + 1}。` });
    }
    if (!page.script.markdown.trim()) {
      items.push({ id: `markdown-${page.id}`, state: "error", pageId: page.id, message: `${page.title}：Markdown 脚本为空。` });
    }
    if (page.offline && !isOfflineFallbackReady(page.offline)) {
      items.push({ id: `offline-${page.id}`, state: "error", pageId: page.id, message: `${page.title}：离线备用内容尚未上传或填写。` });
    }
    if (isOfflineFallbackReady(page.offline)) {
      items.push({ id: `offline-${page.id}`, state: "ok", pageId: page.id, message: `${page.title}：已配置隔离的${page.offline?.kind === "html" ? " HTML" : page.offline?.kind === "video" ? "视频" : "图片"}离线备用内容。` });
    }
    if (page.offline?.kind === "html") {
      const approved = new Set(page.offline.allowedNetworkOrigins ?? []);
      const blocked = requestedOfflineOrigins(page.offline).filter((origin) => !approved.has(origin));
      if (blocked.length > 0) items.push({ id: `offline-network-${page.id}`, state: "warn", pageId: page.id, message: `${page.title}：离线 HTML 请求的 Origin 默认被阻止：${blocked.join("、")}` });
      for (const origin of approved) {
        const host = new URL(origin).hostname;
        const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || /^10\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(host);
        if (local) items.push({ id: `offline-local-network-${page.id}-${host}`, state: "warn", pageId: page.id, message: `${page.title}：已单独授权离线 HTML 访问本机或局域网 Origin ${origin}。` });
      }
    }

    const pageDuplicates = duplicateKeys(page.variables);
    if (pageDuplicates.length > 0) {
      items.push({ id: `page-variable-${page.id}`, state: "error", pageId: page.id, message: `${page.title}：页面变量重复：${pageDuplicates.join("、")}` });
    }

    addTemplateResult(items, page, `markdown-template-${page.id}`, "脚本变量错误：", resolveTemplate(page.script.markdown, project, page, "markdown"));
    addTemplateResult(items, page, `purpose-template-${page.id}`, "页面目的变量错误：", resolveTemplate(page.purpose, project, page));
    if (page.script.fallback) addTemplateResult(items, page, `fallback-template-${page.id}`, "备用讲法变量错误：", resolveTemplate(page.script.fallback, project, page, "markdown"));
    for (const step of page.script.steps) {
      for (const [field, value] of [["步骤", step.text], ["操作", step.action], ["预期", step.expected]] as const) {
        if (value) addTemplateResult(items, page, `step-template-${page.id}-${step.id}-${field}`, `${field}变量错误：`, resolveTemplate(value, project, page));
      }
      if (step.recordedAction?.type === "fill" && step.recordedAction.input.source !== "fixed") {
        const input = step.recordedAction.input;
        const exists = input.source === "project"
          ? project.variables.some((variable) => variable.key === input.key)
          : input.source === "page"
            ? page.variables.some((variable) => variable.key === input.key)
            : project.sensitiveVariables.some((variable) => variable.key === input.key);
        if (!exists) items.push({ id: `fill-variable-${page.id}-${step.id}`, state: "error", pageId: page.id, message: `${page.title}：填写步骤引用了不存在的${input.source === "project" ? "项目变量" : input.source === "page" ? "页面变量" : "敏感变量"} ${input.key}。` });
      }
    }

    const connector = page.connectorId ? project.connectors.find((candidate) => candidate.id === page.connectorId) : undefined;
    if (page.connectorId && !connector) {
      items.push({ id: `connector-${page.id}`, state: "error", pageId: page.id, message: `${page.title}：引用的连接器不存在。` });
    }
    if (connector?.sessionProbe && connector.sessionProbe.roleMappings.length > 0 && !connectorRoleMappings.get(connector.id)?.has(page.role)) {
      items.push({ id: `session-role-${page.id}`, state: "warn", pageId: page.id, message: `${page.title}：连接器已启用角色检查，但未配置“${page.role}”的业务角色映射；本页只检查登录状态。` });
    }

    if (!page.url) {
      items.push({ id: `url-${page.id}`, state: "warn", pageId: page.id, message: `${page.title}：未配置业务 URL，${isOfflineFallbackReady(page.offline) ? "可手动切换至离线备用内容。" : "将使用离线参考画面。"}` });
      continue;
    }

    const resolvedUrl = resolveUrlTemplate(page.url, project, page);
    addTemplateResult(items, page, `url-template-${page.id}`, "业务 URL 错误：", resolvedUrl);
    if (page.fallbackUrl) {
      addTemplateResult(items, page, `fallback-url-${page.id}`, "备用 URL 错误：", resolveUrlTemplate(page.fallbackUrl, project, page));
    }

    if (resolvedUrl.ok && connector) {
      const actualOrigin = normalizedOrigin(resolvedUrl.value);
      const allowedOrigins = new Set([connector.origin, ...connector.allowedOrigins].map(normalizedOrigin).filter(Boolean));
      if (!actualOrigin || !allowedOrigins.has(actualOrigin)) {
        items.push({ id: `origin-${page.id}`, state: "error", pageId: page.id, message: `${page.title}：业务 URL 不在连接器 Origin 白名单中。` });
      }
      if (connector.mode === "iframe" && connector.sandboxPermissions.length === 0) {
        items.push({ id: `sandbox-${page.id}`, state: "warn", pageId: page.id, message: `${page.title}：iframe 未开放脚本或表单能力，请确认业务页仍可使用。` });
      }
      if (connector.securityMode === "request-protection") {
        items.push(connector.mode === "extension"
          ? { id: `protection-${page.id}`, state: "ok", pageId: page.id, message: `${page.title}：已启用扩展请求保护，写操作默认拦截。` }
          : { id: `protection-${page.id}`, state: "error", pageId: page.id, message: `${page.title}：请求保护仅能用于扩展标签模式。` });
      }
      if (connector.securityMode === "readonly-proxy") {
        items.push({ id: `readonly-proxy-${page.id}`, state: "ok", pageId: page.id, message: `${page.title}：将通过本机只读代理加载，写请求默认拦截。` });
      }
    }
  }

  if (!items.some((item) => item.state === "error")) {
    items.unshift({ id: "project-valid", state: "ok", message: `项目结构、${project.pages.length} 页顺序和模板均已校验。` });
  }
  items.push({ id: "markdown-sanitize", state: "ok", message: "Markdown 使用白名单渲染，不执行脚本。" });

  const errors = items.filter((item) => item.state === "error");
  const warnings = items.filter((item) => item.state === "warn");
  return { items, errors, warnings, canPublish: errors.length === 0 };
}
