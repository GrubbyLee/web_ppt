import { Activity, ArrowUpRight, Bell, CheckCircle2, ChevronRight, FileText, Search, ShieldCheck, Users } from "lucide-react";
import type { PresentationPage } from "@showit/contracts";

const roleAsset: Record<string, string> = {
  "访客": "/demo-assets/06-portal-hero.png",
  "能力使用者": "/demo-assets/08-consumer-hero.png",
  "能力录入者": "/demo-assets/11-producer-hero.png",
  "能力运营者": "/demo-assets/14-operator-hero.png",
  "系统管理员": "/demo-assets/16-admin-hero.png"
};

const navItems = ["概览", "能力市场", "应用与凭证", "订阅中心", "资产目录", "运行洞察"];

type BusinessPreviewProps = {
  page: PresentationPage;
};

export function BusinessPreview({ page }: BusinessPreviewProps) {
  const hero = roleAsset[page.role] ?? roleAsset["系统管理员"];

  return (
    <div className="business-preview" aria-label={`${page.businessLabel} 离线预览`}>
      <aside>
        <div className="preview-logo">LC</div>
        <nav>
          {navItems.map((item) => (
            <span className={item === page.businessLabel ? "is-current" : ""} key={item}>
              <ChevronRight size={14} />
              {item}
            </span>
          ))}
        </nav>
        <small>只读演示环境</small>
      </aside>
      <section>
        <header>
          <div>
            <span>LCAPIM / {page.role}</span>
            <strong>{page.businessLabel}</strong>
          </div>
          <div className="preview-header-actions">
            <Search size={17} />
            <Bell size={17} />
            <span>林伟</span>
          </div>
        </header>
        <div className="preview-content">
          <div className="preview-breadcrumb">
            平台工作区 <ChevronRight size={13} /> {page.businessLabel}
          </div>
          <div className="preview-hero">
            <div>
              <span>当前视图</span>
              <h2>{page.businessLabel}</h2>
              <p>{page.purpose}</p>
              <button type="button">
                查看运行状态 <ArrowUpRight size={14} />
              </button>
            </div>
            {hero ? <img src={hero} alt="" /> : null}
          </div>
          <div className="preview-stat-grid">
            <article>
              <Activity size={16} />
              <span>今日调用</span>
              <strong>12,842</strong>
              <small>较昨日 +8.4%</small>
            </article>
            <article>
              <ShieldCheck size={16} />
              <span>安全策略</span>
              <strong>24</strong>
              <small>全部生效</small>
            </article>
            <article>
              <Users size={16} />
              <span>活跃应用</span>
              <strong>38</strong>
              <small>权限已核验</small>
            </article>
          </div>
          <section className="preview-table">
            <header>
              <strong>最近业务记录</strong>
              <span>查看全部</span>
            </header>
            {[
              ["TRC-20260912-0842", "资源状态查询 API", "200", "82ms"],
              ["TRC-20260912-0838", "业务事件研判 MCP", "200", "116ms"],
              ["TRC-20260912-0831", "订阅审批流程", "运行中", "-"]
            ].map(([id, name, status, duration]) => (
              <div className="preview-table-row" key={id}>
                <FileText size={15} />
                <strong>{name}</strong>
                <span>{id}</span>
                <em>{status}</em>
                <small>{duration}</small>
              </div>
            ))}
          </section>
        </div>
      </section>
      <div className="preview-guard">
        <CheckCircle2 size={13} /> LCAPIM 只读代理已连接
      </div>
    </div>
  );
}
