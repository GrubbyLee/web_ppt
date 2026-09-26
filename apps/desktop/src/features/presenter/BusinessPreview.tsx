import { CheckCircle2, ChevronRight, Link2, Monitor, ShieldCheck, UserRound } from "lucide-react";
import type { CSSProperties } from "react";
import type { PresentationPage, Project } from "@showit/contracts";

type BusinessPreviewProps = {
  project: Project;
  page: PresentationPage;
};

const connectorModeLabel = {
  extension: "浏览器扩展",
  iframe: "嵌入页面",
  window: "独立窗口"
} as const;

const securityModeLabel = {
  interactive: "交互模式",
  "request-protection": "请求保护",
  "readonly-proxy": "只读代理"
} as const;

function projectInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  return [...(words[0] ?? "S")].slice(0, 2).join("").toUpperCase();
}

function displayOrigin(url: string | undefined): string {
  if (!url) return "未配置";
  try {
    return new URL(url.replace(/{{[^}]+}}/g, "value")).origin;
  } catch {
    return "URL 模板";
  }
}

export function BusinessPreview({ project, page }: BusinessPreviewProps) {
  const connector = project.connectors.find((candidate) => candidate.id === page.connectorId);
  const visiblePages = project.pages.filter((candidate) => candidate.enabled).slice(0, 7);
  const mode = connector ? connectorModeLabel[connector.mode] : "未配置";
  const security = connector ? securityModeLabel[connector.securityMode] : "未配置";
  const style = {
    "--preview-accent": project.brand.primaryColor,
    "--preview-sidebar": project.brand.statusBackgroundColor
  } as CSSProperties;

  return (
    <div className="business-preview" aria-label={`${page.businessLabel} 业务画面预览`} style={style}>
      <aside>
        <div className="preview-logo" aria-hidden="true">
          {project.brand.logoDataUrl ? <img src={project.brand.logoDataUrl} alt="" /> : projectInitials(project.name)}
        </div>
        <nav aria-label="项目页面">
          {visiblePages.map((candidate) => (
            <span className={candidate.id === page.id ? "is-current" : ""} key={candidate.id}>
              <ChevronRight size={14} />
              {candidate.businessLabel}
            </span>
          ))}
        </nav>
        <small>{project.name}</small>
      </aside>
      <section>
        <header>
          <div>
            <span>{project.name} / {page.section}</span>
            <strong>{page.title}</strong>
          </div>
          <div className="preview-header-actions">
            <ShieldCheck size={15} />
            <span>{security}</span>
          </div>
        </header>
        <div className="preview-content">
          <div className="preview-breadcrumb">
            {page.section} <ChevronRight size={13} /> {page.businessLabel}
          </div>
          <div className="preview-hero">
            <div>
              <span>{page.role}</span>
              <h2>{page.businessLabel}</h2>
              <p>{page.purpose}</p>
              <div className="preview-loading-state">
                <Monitor size={14} />
                {project.brand.loadingMessage}
              </div>
            </div>
          </div>
          <div className="preview-stat-grid">
            <article>
              <UserRound size={16} />
              <span>页面角色</span>
              <strong>{page.role}</strong>
              <small>由项目页面配置</small>
            </article>
            <article>
              <Link2 size={16} />
              <span>连接方式</span>
              <strong>{mode}</strong>
              <small>{displayOrigin(page.url)}</small>
            </article>
            <article>
              <ShieldCheck size={16} />
              <span>安全策略</span>
              <strong>{security}</strong>
              <small>{connector?.environment ?? "默认环境"}</small>
            </article>
          </div>
          <section className="preview-table">
            <header>
              <strong>页面配置</strong>
              <span>{page.tags.length > 0 ? page.tags.join(" · ") : page.pageType}</span>
            </header>
            <div className="preview-table-row">
              <Link2 size={15} />
              <strong>业务地址</strong>
              <span>{displayOrigin(page.url)}</span>
              <em>{page.url ? "已配置" : "待配置"}</em>
            </div>
            <div className="preview-table-row">
              <ShieldCheck size={15} />
              <strong>连接器</strong>
              <span>{connector?.name ?? "未选择连接器"}</span>
              <em>{connector ? "可启动" : "待配置"}</em>
            </div>
          </section>
        </div>
      </section>
      <div className="preview-guard">
        <CheckCircle2 size={13} /> {connector ? `${connector.name} · ${security}` : "等待配置业务连接器"}
      </div>
    </div>
  );
}
