import { FormEvent, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type View = "overview" | "inventory" | "orders" | "settings";

type Product = {
  id: string;
  name: string;
  sku: string;
  category: string;
  stock: number;
  status: "充足" | "偏低" | "缺货";
  price: string;
};

const products: Product[] = [
  { id: "p-100", name: "Arctic Trail Jacket", sku: "ATJ-2401", category: "户外服饰", stock: 248, status: "充足", price: "¥899" },
  { id: "p-101", name: "Harbor Canvas Pack", sku: "HCP-1180", category: "旅行装备", stock: 42, status: "偏低", price: "¥459" },
  { id: "p-102", name: "Summit Field Bottle", sku: "SFB-0912", category: "配件", stock: 0, status: "缺货", price: "¥129" },
  { id: "p-103", name: "Northline Daypack", sku: "NDP-3308", category: "旅行装备", stock: 116, status: "充足", price: "¥329" }
];

const orders = [
  { id: "NS-10482", customer: "杭州远岸户外", value: "¥12,480", status: "待发货", date: "今天 09:42" },
  { id: "NS-10481", customer: "上海山径商贸", value: "¥8,920", status: "运输中", date: "今天 08:16" },
  { id: "NS-10479", customer: "成都旷野零售", value: "¥4,360", status: "已完成", date: "昨天 17:28" }
];

function readLogin(): boolean {
  try { return window.sessionStorage.getItem("northstar:logged-in") === "1"; } catch { return false; }
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account.trim() || !password.trim()) {
      setError("请输入账号和密码");
      return;
    }
    window.sessionStorage.setItem("northstar:logged-in", "1");
    onLogin();
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-mark">N</div>
        <p className="eyebrow">NORTHSTAR SUPPLY</p>
        <h1>运营控制台</h1>
        <p className="login-copy">管理库存、订单和供应链状态</p>
        <form onSubmit={submit} className="login-form">
          <label>工作邮箱<input data-testid="login-username" value={account} onChange={(event) => setAccount(event.target.value)} autoComplete="username" placeholder="name@northstar.example" /></label>
          <label>密码<input data-testid="login-password" value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" placeholder="请输入密码" /></label>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button data-testid="login-submit" className="primary-button" type="submit">登录运营台</button>
        </form>
        <p className="login-hint">演示环境 · 数据仅保存在当前浏览器会话</p>
      </section>
    </main>
  );
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill status-${status === "充足" || status === "已完成" ? "good" : status === "偏低" || status === "待发货" ? "warn" : "neutral"}`}>{status}</span>;
}

function Overview({ setView }: { setView: (view: View) => void }) {
  return <>
    <div className="page-heading"><div><p className="eyebrow">运营概览</p><h2>早上好，林遥</h2><p className="muted">这是 Northstar Supply 的今日运营快照。</p></div><button className="secondary-button" onClick={() => setView("inventory")}>查看库存</button></div>
    <div className="metric-grid">
      <article className="metric-card"><span>可售库存</span><strong>406</strong><small className="positive">较上周 +8.4%</small></article>
      <article className="metric-card"><span>待处理订单</span><strong>18</strong><small>需要今天发出</small></article>
      <article className="metric-card"><span>库存周转率</span><strong>4.8x</strong><small className="positive">较上月 +0.6x</small></article>
      <article className="metric-card"><span>供应商准时率</span><strong>96.2%</strong><small className="positive">目标 95%</small></article>
    </div>
    <div className="content-grid">
      <section className="surface"><div className="section-heading"><div><p className="eyebrow">库存预警</p><h3>需要关注的商品</h3></div><button className="text-button" onClick={() => setView("inventory")}>查看全部</button></div><div className="alert-list">{products.filter((product) => product.status !== "充足").map((product) => <div className="alert-row" key={product.id}><div><strong>{product.name}</strong><span>{product.sku} · {product.category}</span></div><StatusPill status={product.status} /></div>)}</div></section>
      <section className="surface"><div className="section-heading"><div><p className="eyebrow">订单流转</p><h3>最近订单</h3></div><button className="text-button" onClick={() => setView("orders")}>订单中心</button></div><div className="order-list">{orders.map((order) => <div className="order-row" key={order.id}><div><strong>{order.id}</strong><span>{order.customer} · {order.date}</span></div><div className="order-meta"><b>{order.value}</b><StatusPill status={order.status} /></div></div>)}</div></section>
    </div>
  </>;
}

function Inventory() {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => products.filter((product) => `${product.name} ${product.sku} ${product.category}`.toLowerCase().includes(query.toLowerCase())), [query]);
  return <><div className="page-heading"><div><p className="eyebrow">商品目录</p><h2>库存管理</h2><p className="muted">查看库存状态、SKU 和补货优先级。</p></div><button className="primary-button">新增商品</button></div><section className="surface"><div className="toolbar"><input data-testid="inventory-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品、SKU 或分类" /><span className="muted">{visible.length} 个商品</span></div><div className="table-wrap"><table><thead><tr><th>商品</th><th>SKU</th><th>分类</th><th>库存</th><th>状态</th><th>价格</th></tr></thead><tbody>{visible.map((product) => <tr key={product.id}><td><strong>{product.name}</strong></td><td>{product.sku}</td><td>{product.category}</td><td>{product.stock}</td><td><StatusPill status={product.status} /></td><td>{product.price}</td></tr>)}</tbody></table></div></section></>;
}

function Orders() {
  return <><div className="page-heading"><div><p className="eyebrow">履约中心</p><h2>订单管理</h2><p className="muted">跟踪订单状态和配送进度。</p></div><button className="secondary-button">导出报表</button></div><section className="surface"><div className="table-wrap"><table><thead><tr><th>订单号</th><th>客户</th><th>金额</th><th>状态</th><th>更新时间</th></tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td><strong>{order.id}</strong></td><td>{order.customer}</td><td>{order.value}</td><td><StatusPill status={order.status} /></td><td>{order.date}</td></tr>)}</tbody></table></div></section></>;
}

function Settings() {
  return <><div className="page-heading"><div><p className="eyebrow">工作区设置</p><h2>运营偏好</h2><p className="muted">管理通知、团队和仓库信息。</p></div></div><section className="surface settings"><label>工作区名称<input defaultValue="Northstar Supply" /></label><label>默认仓库<select defaultValue="hangzhou"><option value="hangzhou">杭州仓</option><option value="shanghai">上海仓</option></select></label><label className="toggle-row"><span><strong>低库存通知</strong><small>库存低于安全线时通知运营团队</small></span><input type="checkbox" defaultChecked /></label></section></>;
}

function App() {
  const [loggedIn, setLoggedIn] = useState(readLogin);
  const [view, setView] = useState<View>("overview");
  if (!loggedIn) return <Login onLogin={() => setLoggedIn(true)} />;
  function logout() { window.sessionStorage.removeItem("northstar:logged-in"); setLoggedIn(false); }
  return <div className="app-shell"><aside className="sidebar"><div className="side-brand"><span className="brand-mark small">N</span><div><strong>Northstar</strong><small>Supply Operations</small></div></div><nav><button data-testid="nav-overview" className={view === "overview" ? "active" : ""} onClick={() => setView("overview")}>运营概览</button><button data-testid="nav-inventory" className={view === "inventory" ? "active" : ""} onClick={() => setView("inventory")}>库存管理</button><button data-testid="nav-orders" className={view === "orders" ? "active" : ""} onClick={() => setView("orders")}>订单中心</button></nav><div className="sidebar-bottom"><button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>工作区设置</button></div></aside><main className="main-shell"><header className="topbar"><div className="breadcrumb">杭州仓 <span>/</span> {view === "overview" ? "运营概览" : view === "inventory" ? "库存管理" : view === "orders" ? "订单中心" : "工作区设置"}</div><div className="user-menu"><span className="online-dot" /> 林遥 <button onClick={logout}>退出</button></div></header><div className="content">{view === "overview" ? <Overview setView={setView} /> : view === "inventory" ? <Inventory /> : view === "orders" ? <Orders /> : <Settings />}</div></main></div>;
}

createRoot(document.getElementById("root")!).render(<App />);
