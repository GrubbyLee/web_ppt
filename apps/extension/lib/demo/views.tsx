import { useMemo, useState } from "react";
import {
  approvals,
  applyDemoMutation,
  demoActivity,
  type DemoMutation,
  demoCapabilities,
  demoProtocolShare,
  demoTraces,
  demoUsageByDay,
  demoUsers,
  readDemoSession,
  registryAssets,
  writeDemoSession,
  type DemoSession
} from "./data";
import "./demo.css";

export type DemoView =
  | "login"
  | "overview"
  | "portal"
  | "marketplace"
  | "subscriptions"
  | "studio"
  | "studio-details"
  | "registry"
  | "approvals"
  | "operations"
  | "admin"
  | "admin-controls";

export const demoNav: Array<{ group: string; items: Array<{ view: DemoView; label: string }> }> = [
  { group: "工作台", items: [{ view: "overview", label: "平台指挥台" }, { view: "portal", label: "能力门户" }] },
  { group: "能力消费", items: [{ view: "marketplace", label: "能力市场" }, { view: "subscriptions", label: "订阅中心" }] },
  { group: "能力供给", items: [{ view: "studio", label: "能力工作室" }, { view: "studio-details", label: "资产详情" }, { view: "registry", label: "资产目录" }] },
  { group: "运营治理", items: [{ view: "approvals", label: "审批队列" }, { view: "operations", label: "运行洞察" }] },
  { group: "平台管理", items: [{ view: "admin", label: "用户与组织" }, { view: "admin-controls", label: "权限与流程" }] }
];

// ---- shared bits -----------------------------------------------------------------

function StatusChip({ value }: { value: string }) {
  const tone = value === "运行中" || value === "已上架" || value === "已通过" || value === "启用" || value === "200"
    ? "ok"
    : value === "待发布" || value === "待审批" || value === "开发中"
      ? "pending"
      : value === "已下线" || value === "已驳回" || value === "停用" || value === "403"
        ? "off"
        : "muted";
  return <span className={`demo-chip demo-chip--${tone}`}>{value}</span>;
}

function KpiCard({ label, value, unit, trend }: { label: string; value: string; unit?: string; trend?: string }) {
  return (
    <div className="demo-kpi">
      <span>{label}</span>
      <strong>{value}{unit ? <small>{unit}</small> : null}</strong>
      {trend ? <em>{trend}</em> : null}
    </div>
  );
}

function LineChart({ series, height = 150 }: { series: number[]; height?: number }) {
  const width = 520;
  const max = Math.max(...series) * 1.15;
  const step = width / (series.length - 1);
  const points = series.map((value, index) => [index * step, height - (value / max) * height] as const);
  const path = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${path} L${width},${height} L0,${height} Z`;
  return (
    <svg className="demo-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="调用趋势图">
      <path d={area} fill="rgba(59,130,246,0.12)" />
      <path d={path} fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {points.map(([x, y], index) => <circle key={index} cx={x} cy={y} r="2.5" fill="#3b82f6" />)}
    </svg>
  );
}

function BarChart({ data }: { data: Array<{ day: string; calls: number; failures: number }> }) {
  const max = Math.max(...data.map((item) => item.calls)) * 1.1;
  return (
    <div className="demo-bars">
      {data.map((item) => (
        <div key={item.day} className="demo-bars__col" title={`${item.day}：${item.calls.toLocaleString()} 次调用，${item.failures} 次失败`}>
          <div className="demo-bars__track">
            <div className="demo-bars__value" style={{ height: `${(item.calls / max) * 100}%` }} />
            <div className="demo-bars__failure" style={{ height: `${(item.failures / max) * 100}%` }} />
          </div>
          <span>{item.day}</span>
        </div>
      ))}
    </div>
  );
}

function Donut({ data }: { data: Array<{ label: string; value: number }> }) {
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const colors = ["#3b82f6", "#8b5cf6", "#14b8a6", "#f59e0b"];
  let offset = 0;
  const circumference = 2 * Math.PI * 40;
  return (
    <div className="demo-donut">
      <svg viewBox="0 0 100 100" role="img" aria-label="协议占比">
        {data.map((item, index) => {
          const length = (item.value / total) * circumference;
          const circle = (
            <circle
              key={item.label}
              cx="50"
              cy="50"
              r="40"
              fill="none"
              stroke={colors[index % colors.length]}
              strokeWidth="14"
              strokeDasharray={`${length} ${circumference - length}`}
              strokeDashoffset={-offset}
            />
          );
          offset += length;
          return circle;
        })}
      </svg>
      <ul>
        {data.map((item, index) => <li key={item.label}><i style={{ background: colors[index % colors.length] }} />{item.label}<strong>{item.value}%</strong></li>)}
      </ul>
    </div>
  );
}

function ViewHeader({ title, description, actions }: { title: string; description: string; actions?: React.ReactNode }) {
  return (
    <header className="demo-view__head">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="demo-view__actions">{actions}</div> : null}
    </header>
  );
}

// ---- views ----------------------------------------------------------------------

export function LoginView({ onLogin }: { onLogin: (session: DemoSession) => void }) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!account.trim() || !password) {
      setError("请输入账号和密码。");
      return;
    }
    onLogin({ account: account.trim(), name: "林一舟", role: "系统管理员", loggedInAt: Date.now() });
  };

  return (
    <main className="demo-login" data-testid="login-card">
      <section className="demo-login__card">
        <div className="demo-login__brand">
          <span className="demo-logo" aria-hidden="true">云枢</span>
          <div>
            <h1>云枢 · 能力开放平台</h1>
            <p>统一的能力接入、订阅、审批与运行治理</p>
          </div>
        </div>
        <form onSubmit={submit}>
          <label>
            <span>账号</span>
            <input data-testid="login-username" value={account} autoComplete="username" onChange={(event) => setAccount(event.target.value)} />
          </label>
          <label>
            <span>密码</span>
            <input data-testid="login-password" type="password" value={password} autoComplete="current-password" placeholder="演示密码由 Showit 敏感变量提供" onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error ? <p className="demo-login__error" role="alert">{error}</p> : null}
          <button type="submit" data-testid="login-submit">登录</button>
        </form>
        <footer>
          <p>演示账号：demo@cloudpivot.cn</p>
          <p>密码在演示启动时通过 Showit 敏感变量输入，不保存在项目中。</p>
        </footer>
      </section>
    </main>
  );
}

export function OverviewView() {
  return (
    <section className="demo-view">
      <ViewHeader title="平台指挥台" description="今日调用、在线能力、待审批与告警的总览。" />
      <div className="demo-kpis" data-testid="overview-kpis">
        <KpiCard label="今日调用" value="12,847" unit="次" trend="较昨日 +8.4%" />
        <KpiCard label="在线能力" value="36" unit="项" trend="本周新增 2 项" />
        <KpiCard label="待审批" value={String(approvals().filter((item) => item.status === "待审批").length)} unit="件" />
        <KpiCard label="活跃告警" value="1" unit="条" trend="凭证到期提醒" />
      </div>
      <div className="demo-grid demo-grid--2">
        <div className="demo-panel">
          <h2>近 14 日调用趋势</h2>
          <div data-testid="overview-trend">
            <LineChart series={[8_100, 8_400, 7_950, 9_020, 10_480, 11_200, 6_900, 6_400, 8_850, 9_300, 9_140, 10_720, 11_960, 12_847]} />
          </div>
        </div>
        <div className="demo-panel">
          <h2>最近动态</h2>
          <ul className="demo-activity" data-testid="activity-feed">
            {demoActivity.map((item) => (
              <li key={item.at}><time>{item.at}</time>{item.text}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

export function PortalView() {
  return (
    <section className="demo-view">
      <ViewHeader title="能力门户" description="访客可见的公开视图：发现、理解、评估能力，无需进入管理面。" />
      <div className="demo-hero" data-testid="portal-hero">
        <h2>把企业的数据、服务与智能，变成可治理的能力</h2>
        <p>36 项已上架能力 · 5 类资产形态 · 全链路审批与审计</p>
      </div>
      <div className="demo-cards" data-testid="portal-cards">
        {demoCapabilities.filter((item) => item.status === "已上架").slice(0, 3).map((item) => (
          <article key={item.id} className="demo-card">
            <header><strong>{item.name}</strong><StatusChip value={item.status} /></header>
            <p>{item.description}</p>
            <footer><span>{item.provider}</span><code>{item.version}</code></footer>
          </article>
        ))}
      </div>
    </section>
  );
}

export function MarketplaceView() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const results = useMemo(() => {
    const keyword = query.trim();
    if (!keyword) return demoCapabilities;
    return demoCapabilities.filter((item) => `${item.name}${item.description}${item.type}`.includes(keyword));
  }, [query]);
  const detail = demoCapabilities.find((item) => item.id === selected) ?? null;

  return (
    <section className="demo-view">
      <ViewHeader
        title="能力市场"
        description="按名称、类型或描述搜索能力；点击卡片查看版本、提供方与接入流程。"
        actions={
          <form className="demo-search" onSubmit={(event) => event.preventDefault()}>
            <input data-testid="market-search" value={query} placeholder="搜索能力，例如：资源状态" aria-label="搜索能力" onChange={(event) => setQuery(event.target.value)} />
            <button type="button" data-testid="market-search-btn" onClick={() => setQuery(query)}>搜索</button>
          </form>
        }
      />
      <div className="demo-cards" data-testid="market-results">
        {results.map((item) => (
          <article key={item.id} className="demo-card" data-testid={`market-card-${item.id}`} data-selected={selected === item.id || undefined} onClick={() => setSelected(item.id)}>
            <header><strong>{item.name}</strong><StatusChip value={item.status} /></header>
            <p>{item.description}</p>
            <footer><span className="demo-tag">{item.type}</span><span>{item.provider}</span><code>{item.version}</code></footer>
          </article>
        ))}
        {results.length === 0 ? <p className="demo-empty">没有匹配的能力，请调整搜索词。</p> : null}
      </div>
      {detail ? (
        <aside className="demo-detail" data-testid="market-detail">
          <header>
            <strong>{detail.name}</strong>
            <button type="button" onClick={() => setSelected(null)} aria-label="关闭详情">✕</button>
          </header>
          <dl>
            <div><dt>版本</dt><dd>{detail.version}</dd></div>
            <div><dt>提供方</dt><dd>{detail.provider}</dd></div>
            <div><dt>端点</dt><dd><code>{detail.endpoint}</code></dd></div>
            <div><dt>状态</dt><dd><StatusChip value={detail.status} /></dd></div>
          </dl>
          <ol className="demo-steps">
            <li>切换到能力使用者角色，创建或选择应用身份。</li>
            <li>在订阅中心申请订阅，选择资源范围（如 G4）。</li>
            <li>审批通过后使用应用凭证调用，用量与 Trace 自动归集。</li>
          </ol>
        </aside>
      ) : null}
    </section>
  );
}

export function SubscriptionsView() {
  return (
    <section className="demo-view">
      <ViewHeader title="订阅中心" description="应用身份、订阅关系、调用用量与成功率的闭环证据。" />
      <div className="demo-panel" data-testid="app-identity">
        <h2>运营监测应用</h2>
        <dl className="demo-facts">
          <div><dt>应用凭证</dt><dd><code>AK****7f2a</code>（已脱敏）</dd></div>
          <div><dt>资源范围</dt><dd>G4 示例资源组</dd></div>
          <div><dt>IP 白名单</dt><dd>10.6.0.0/16</dd></div>
          <div><dt>凭证状态</dt><dd>14 天后到期，已提醒</dd></div>
        </dl>
      </div>
      <div className="demo-panel">
        <table className="demo-table" data-testid="sub-table">
          <thead><tr><th>能力</th><th>状态</th><th>范围</th><th>近 7 日调用</th><th>成功率</th></tr></thead>
          <tbody>
            <tr>
              <td>资源状态查询 API</td>
              <td data-testid="sub-status-running"><StatusChip value="运行中" /></td>
              <td>G4</td>
              <td>12,847</td>
              <td>99.6%</td>
            </tr>
            <tr>
              <td>资产变更事件流</td>
              <td><StatusChip value="运行中" /></td>
              <td>全部</td>
              <td>3,204</td>
              <td>100%</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="demo-grid demo-grid--2">
        <div className="demo-panel">
          <h2>近 7 日调用量</h2>
          <div data-testid="usage-chart"><BarChart data={demoUsageByDay} /></div>
        </div>
        <div className="demo-panel">
          <h2>资产形态占比</h2>
          <Donut data={demoProtocolShare} />
        </div>
      </div>
    </section>
  );
}

export function StudioView() {
  const types = demoCapabilities.map((item) => ({ type: item.type, description: item.description, id: item.id }));
  const unique = [...new Map(types.map((item) => [item.type, item])).values()];
  return (
    <section className="demo-view">
      <ViewHeader title="能力工作室" description="五种录入方式最终沉淀为共享分类、权限、版本、审批与审计合同的资产。" />
      <div className="demo-cards" data-testid="studio-cards">
        {unique.map((item) => (
          <article key={item.type} className="demo-card demo-card--entry" data-testid={`studio-item-${item.type}`}>
            <strong>{item.type}</strong>
            <p>{item.description}</p>
          </article>
        ))}
      </div>
      <div className="demo-panel">
        <h2>统一治理要点</h2>
        <ul className="demo-list">
          <li>所有形态共享分类、权限与版本合同。</li>
          <li>上架与高风险变更统一进入审批队列。</li>
          <li>调用证据（用量与 Trace）自动归集到运行洞察。</li>
        </ul>
      </div>
    </section>
  );
}

export function StudioDetailsView() {
  const asset = registryAssets().find((item) => item.id === "asset-resource-status")!;
  return (
    <section className="demo-view">
      <ViewHeader title={`资产详情 · ${asset.name}`} description="端点、双环境、健康检查与版本历史同属一项资产。" />
      <div className="demo-panel" data-testid="api-endpoints">
        <h2>服务端点</h2>
        <table className="demo-table">
          <thead><tr><th>方法</th><th>路径</th><th>协议</th><th>鉴权</th></tr></thead>
          <tbody>
            <tr><td>GET</td><td><code>/api/v2/resources/{"{id}"}/status</code></td><td>REST</td><td>应用凭证 + 范围</td></tr>
            <tr><td>GET</td><td><code>/api/v2/resources</code></td><td>REST</td><td>应用凭证 + 范围</td></tr>
            <tr><td>POST</td><td><code>/api/v2/resources/query</code></td><td>REST</td><td>应用凭证 + 范围</td></tr>
          </tbody>
        </table>
      </div>
      <div className="demo-grid demo-grid--2">
        <div className="demo-panel" data-testid="api-environments">
          <h2>双环境</h2>
          <ul className="demo-list">
            <li>开发环境：mock 后端，供联调。</li>
            <li>生产环境：经网关路由，QPS / 配额 / 脱敏策略生效。</li>
          </ul>
        </div>
        <div className="demo-panel" data-testid="api-health">
          <h2>健康检查</h2>
          <dl className="demo-facts">
            <div><dt>最近探测</dt><dd>10:40（200，38ms）</dd></div>
            <div><dt>连续成功</dt><dd>42 次</dd></div>
          </dl>
        </div>
      </div>
      <div className="demo-panel" data-testid="api-versions">
        <h2>版本历史</h2>
        <table className="demo-table">
          <thead><tr><th>版本</th><th>状态</th><th>变更摘要</th><th>时间</th></tr></thead>
          <tbody>
            <tr><td>v2.3.1</td><td><StatusChip value="运行中" /></td><td>新增按分组过滤参数</td><td>09-24</td></tr>
            <tr><td>v2.3.0</td><td><StatusChip value="已下线" /></td><td>响应字段归一化</td><td>08-30</td></tr>
            <tr><td>v2.2.4</td><td><StatusChip value="已下线" /></td><td>修复分页越界</td><td>08-02</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function RegistryView({ onRefresh, onMutate }: { onRefresh?: (() => void) | undefined; onMutate?: ((mutation: DemoMutation) => void) | undefined }) {
  const [filter, setFilter] = useState<"all" | "运行中" | "待发布" | "已下线">("all");
  const [selected, setSelected] = useState<string | null>("asset-ops-copilot");
  const [quotaDraft, setQuotaDraft] = useState<string | null>(null);
  const assets = registryAssets().filter((asset) => filter === "all" || asset.lifecycle === filter);
  const detail = registryAssets().find((item) => item.id === selected) ?? null;

  const mutate = (mutation: DemoMutation) => {
    applyDemoMutation(mutation);
    onMutate?.(mutation);
    if (detail) setQuotaDraft(String(detail.quota));
    onRefresh?.();
  };

  return (
    <section className="demo-view">
      <ViewHeader
        title="资产目录"
        description="已上架资产的生命周期、配额与责任人；高风险变更需经审批。"
        actions={
          <select data-testid="registry-filter" value={filter} aria-label="状态筛选" onChange={(event) => setFilter(event.target.value as typeof filter)}>
            <option value="all">全部状态</option>
            <option value="运行中">运行中</option>
            <option value="待发布">待发布</option>
            <option value="已下线">已下线</option>
          </select>
        }
      />
      <table className="demo-table" data-testid="registry-table">
        <thead><tr><th>资产</th><th>形态</th><th>版本</th><th>责任人</th><th>生命周期</th><th>配额（次/分）</th><th>更新</th></tr></thead>
        <tbody>
          {assets.map((asset) => (
            <tr key={asset.id} data-testid={`registry-row-${asset.id}`} data-selected={selected === asset.id || undefined} onClick={() => { setSelected(asset.id); setQuotaDraft(String(asset.quota)); }}>
              <td><strong>{asset.name}</strong></td>
              <td><span className="demo-tag">{asset.type}</span></td>
              <td><code>{asset.version}</code></td>
              <td>{asset.owner}</td>
              <td><StatusChip value={asset.lifecycle} /></td>
              <td>{asset.quota}</td>
              <td>{asset.updatedAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {detail ? (
        <aside className="demo-detail" data-testid="api-detail">
          <header><strong>{detail.name} · {detail.version}</strong><span className="demo-tag">{detail.type}</span></header>
          <dl>
            <div><dt>责任人</dt><dd>{detail.owner}</dd></div>
            <div><dt>生命周期</dt><dd><StatusChip value={detail.lifecycle} /></dd></div>
          </dl>
          <div className="demo-detail__quota">
            <label>
              <span>调用配额（次/分）</span>
              <input data-testid="quota-input" type="number" min={10} max={6000} value={quotaDraft ?? String(detail.quota)} onChange={(event) => setQuotaDraft(event.target.value)} />
            </label>
            <button type="button" data-testid="save-quota" onClick={() => {
              const value = Math.round(Math.min(6000, Math.max(10, Number(quotaDraft) || detail.quota)));
              mutate({ kind: "quota", assetId: detail.id, value });
            }}>保存配额</button>
          </div>
          <div className="demo-detail__lifecycle">
            <button type="button" data-testid="publish-api" disabled={detail.lifecycle === "运行中"} onClick={() => mutate({ kind: "publish", assetId: detail.id })}>发布能力</button>
            <button type="button" data-testid="offline-api" disabled={detail.lifecycle !== "运行中"} onClick={() => mutate({ kind: "offline", assetId: detail.id })}>下线能力</button>
            <span data-testid={detail.lifecycle === "运行中" ? "api-status-running" : "api-status-idle"}><StatusChip value={detail.lifecycle} /></span>
          </div>
          <p className="demo-note">发布已上架资产属于高风险变更：Showit 会在控制台要求显式确认，并在审计中记录。</p>
        </aside>
      ) : null}
    </section>
  );
}

export function ApprovalsView({ onRefresh, onMutate }: { onRefresh?: (() => void) | undefined; onMutate?: ((mutation: DemoMutation) => void) | undefined }) {
  const [selected, setSelected] = useState<string | null>("approval-customer-master");
  const list = approvals();
  const detail = list.find((item) => item.id === selected) ?? null;
  return (
    <section className="demo-view">
      <ViewHeader title="审批队列" description="变更、订阅与发布申请的状态机；审批意见是审计输入。" />
      <table className="demo-table" data-testid="approvals-table">
        <thead><tr><th>申请</th><th>类型</th><th>申请人</th><th>状态</th><th>提交</th><th></th></tr></thead>
        <tbody>
          {list.map((item) => (
            <tr key={item.id} data-selected={selected === item.id || undefined}>
              <td><strong>{item.title}</strong></td>
              <td><span className="demo-tag">{item.kind}</span></td>
              <td>{item.applicant}</td>
              <td data-testid={item.id === "approval-customer-master" ? (item.status === "已通过" ? "approval-status-approved" : "approval-status") : undefined}><StatusChip value={item.status} /></td>
              <td>{item.submittedAt}</td>
              <td>
                {item.status === "待审批" ? (
                  <button type="button" data-testid="approve-order" onClick={() => {
                    applyDemoMutation({ kind: "approve", approvalId: item.id });
                    onMutate?.({ kind: "approve", approvalId: item.id });
                    onRefresh?.();
                  }}>通过</button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {detail ? (
        <aside className="demo-detail" data-testid="approval-detail">
          <header><strong>{detail.title}</strong></header>
          <dl>
            <div><dt>申请人</dt><dd>{detail.applicant}</dd></div>
            <div><dt>资源</dt><dd>{detail.resource}</dd></div>
            <div><dt>类型</dt><dd>{detail.kind}</dd></div>
            <div><dt>状态</dt><dd><StatusChip value={detail.status} /></dd></div>
            <div><dt>审批意见</dt><dd>{detail.opinion || "—"}</dd></div>
          </dl>
          <p className="demo-note">审批决定会驱动生效、通知与版本动作，并进入审计日志。</p>
        </aside>
      ) : null}
    </section>
  );
}

export function OperationsView() {
  return (
    <section className="demo-view">
      <ViewHeader title="运行洞察" description="网关、Trace、节点与集成状态的统一运营视图。" />
      <div className="demo-panel" data-testid="trace-table">
        <h2>最近调用</h2>
        <table className="demo-table">
          <thead><tr><th>Trace ID</th><th>调用方</th><th>能力 / 路径</th><th>状态码</th><th>耗时</th><th>时间</th></tr></thead>
          <tbody>
            {demoTraces.map((trace) => (
              <tr key={trace.id}>
                <td><code>{trace.id}</code></td>
                <td>{trace.caller}</td>
                <td>{trace.capability}<br /><small><code>{trace.path}</code></small></td>
                <td><StatusChip value={String(trace.status)} /></td>
                <td>{trace.latencyMs}ms</td>
                <td>{trace.at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="demo-grid demo-grid--2">
        <div className="demo-panel" data-testid="gateway-policy">
          <h2>网关策略（示例资源组 G4）</h2>
          <dl className="demo-facts">
            <div><dt>QPS 上限</dt><dd>500</dd></div>
            <div><dt>配额</dt><dd>10,000 次/分</dd></div>
            <div><dt>熔断</dt><dd>错误率 &gt; 50% 持续 30s</dd></div>
            <div><dt>脱敏</dt><dd>响应字段 mobile / email 自动脱敏</dd></div>
          </dl>
        </div>
        <div className="demo-panel" data-testid="node-health">
          <h2>网关节点</h2>
          <ul className="demo-list">
            <li>gateway-01 · 健康 · 4C8G · 负载 41%</li>
            <li>gateway-02 · 健康 · 4C8G · 负载 37%</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

export function AdminView() {
  return (
    <section className="demo-view">
      <ViewHeader title="用户与组织" description="用户绑定组织、角色与状态，可配置细粒度权限覆盖。" />
      <table className="demo-table" data-testid="user-table">
        <thead><tr><th>姓名</th><th>账号</th><th>角色</th><th>组织</th><th>状态</th><th>权限覆盖</th></tr></thead>
        <tbody>
          {demoUsers.map((user) => (
            <tr key={user.account}>
              <td><strong>{user.name}</strong></td>
              <td><code>{user.account}</code></td>
              <td>{user.role}</td>
              <td>{user.org}</td>
              <td><StatusChip value={user.status} /></td>
              <td>{user.override ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function AdminControlsView() {
  return (
    <section className="demo-view">
      <ViewHeader title="权限与流程" description="角色模板、密钥状态与已发布审批流程的组织级控制项。" />
      <div className="demo-panel" data-testid="role-templates">
        <h2>角色模板</h2>
        <table className="demo-table">
          <thead><tr><th>角色</th><th>菜单范围</th><th>说明</th></tr></thead>
          <tbody>
            <tr><td>访客</td><td>门户、市场、文档</td><td>只读发现，不进入管理面</td></tr>
            <tr><td>能力使用者</td><td>市场、订阅、用量</td><td>应用身份与订阅管理</td></tr>
            <tr><td>能力录入者</td><td>工作室、资产目录</td><td>资产录入与生命周期</td></tr>
            <tr><td>能力运营者</td><td>审批、运行洞察</td><td>审批决策与网关策略</td></tr>
            <tr><td>系统管理员</td><td>全部</td><td>组织、权限与流程治理</td></tr>
          </tbody>
        </table>
      </div>
      <div className="demo-grid demo-grid--2">
        <div className="demo-panel" data-testid="keys-masked">
          <h2>密钥状态</h2>
          <ul className="demo-list">
            <li>网关签名密钥：<code>SK****90de</code>（已脱敏）· 90 天轮换</li>
            <li>适配层凭据：<code>AK****3b1c</code>（已脱敏）· 托管于密钥服务</li>
          </ul>
        </div>
        <div className="demo-panel" data-testid="workflow-nodes">
          <h2>已发布流程：能力订阅审批</h2>
          <ol className="demo-flow">
            <li><strong>能力录入者</strong> · 提交订阅申请<small>自动校验范围与配额</small></li>
            <li><strong>能力运营者</strong> · 审批决定<small>通过后生效并通知调用方</small></li>
          </ol>
        </div>
      </div>
    </section>
  );
}

export function demoViewFromUrl(url: string | undefined): DemoView | null {
  if (!url?.startsWith("demo://")) return null;
  const view = url.slice("demo://".length) as DemoView;
  const known = new Set(demoNav.flatMap((group) => group.items.map((item) => item.view)));
  return known.has(view) ? view : null;
}

export { readDemoSession, writeDemoSession };
export type { DemoSession };
