/**
 * Fixtures and mutable state for the built-in demo console
 * (「云枢 · 能力开放平台」— a fictional API governance SaaS).
 *
 * All data is local; mutations live in memory for the tab's lifetime, the
 * login session in sessionStorage. No network requests are ever made.
 */

export type CapabilityType = "API" | "MCP" | "AI Skill" | "Kafka" | "数据源";

export type Capability = {
  id: string;
  name: string;
  type: CapabilityType;
  version: string;
  provider: string;
  status: "已上架" | "开发中";
  description: string;
  endpoint: string;
};

export type RegistryAsset = {
  id: string;
  name: string;
  type: CapabilityType;
  version: string;
  owner: string;
  lifecycle: "待发布" | "运行中" | "已下线";
  quota: number;
  updatedAt: string;
};

export type Approval = {
  id: string;
  title: string;
  applicant: string;
  resource: string;
  kind: "变更" | "订阅" | "发布";
  status: "待审批" | "已通过" | "已驳回";
  opinion: string;
  submittedAt: string;
};

export type Trace = {
  id: string;
  caller: string;
  capability: string;
  path: string;
  status: number;
  latencyMs: number;
  at: string;
};

export type DemoUser = {
  name: string;
  account: string;
  role: string;
  org: string;
  status: "启用" | "停用";
  override?: string;
};

export const demoCapabilities: Capability[] = [
  { id: "resource-status", name: "资源状态查询 API", type: "API", version: "v2.3.1", provider: "平台运营部", status: "已上架", description: "查询客户资源的状态、健康度与最近变更记录，支持按资源编号和分组过滤。", endpoint: "GET /api/v2/resources/{id}/status" },
  { id: "customer-master", name: "客户主数据同步", type: "API", version: "v2.4.0", provider: "数据服务部", status: "已上架", description: "双向同步客户主数据，支持增量拉取与幂等写入。", endpoint: "POST /api/v2/customers/sync" },
  { id: "ticket-intent", name: "工单意图识别 Skill", type: "AI Skill", version: "v1.8.2", provider: "智能服务部", status: "已上架", description: "对工单文本进行意图分类与紧急度评估，返回结构化标签。", endpoint: "POST /ai/v1/tickets/intent" },
  { id: "asset-events", name: "资产变更事件流", type: "Kafka", version: "v1.2.0", provider: "平台运营部", status: "已上架", description: "发布资产上架、变更与下线事件，供下游审计与缓存失效消费。", endpoint: "topic: asset.events.v1" },
  { id: "ops-copilot", name: "运维助手 MCP", type: "MCP", version: "v0.9.4", provider: "平台工程部", status: "开发中", description: "以 MCP 工具形式暴露节点巡检、日志摘要与告警确认能力。", endpoint: "mcp: ops-copilot" },
  { id: "billing-source", name: "计费明细数据源", type: "数据源", version: "v3.0.1", provider: "数据服务部", status: "已上架", description: "只读数据源：按天聚合的 API 调用计费明细与账期维度。", endpoint: "datasource: billing.daily" }
];

export const demoRegistryAssets: RegistryAsset[] = [
  { id: "asset-resource-status", name: "资源状态查询 API", type: "API", version: "v2.3.1", owner: "平台运营部", lifecycle: "运行中", quota: 600, updatedAt: "09-24 14:20" },
  { id: "asset-customer-master", name: "客户主数据同步", type: "API", version: "v2.4.0", owner: "数据服务部", lifecycle: "运行中", quota: 300, updatedAt: "09-22 09:12" },
  { id: "asset-billing-source", name: "计费明细数据源", type: "数据源", version: "v3.0.1", owner: "数据服务部", lifecycle: "运行中", quota: 120, updatedAt: "09-18 16:40" },
  { id: "asset-ops-copilot", name: "运维助手 MCP", type: "MCP", version: "v0.9.4", owner: "平台工程部", lifecycle: "待发布", quota: 60, updatedAt: "09-27 11:05" },
  { id: "asset-ticket-intent", name: "工单意图识别 Skill", type: "AI Skill", version: "v1.8.2", owner: "智能服务部", lifecycle: "运行中", quota: 240, updatedAt: "09-20 10:31" }
];

export const demoApprovals: Approval[] = [
  { id: "approval-customer-master", title: "客户主数据同步 v2.4 变更申请", applicant: "王澜（能力录入者）", resource: "客户主数据同步", kind: "变更", status: "待审批", opinion: "", submittedAt: "09-28 09:41" },
  { id: "approval-ops-subscription", title: "运营监测应用 订阅 资源状态查询 API", applicant: "李澄（能力使用者）", resource: "资源状态查询 API", kind: "订阅", status: "已通过", opinion: "范围符合 G4 白名单。", submittedAt: "09-26 15:03" },
  { id: "approval-ticket-publish", title: "工单意图识别 Skill v1.8 发布申请", applicant: "赵禾（能力录入者）", resource: "工单意图识别 Skill", kind: "发布", status: "已通过", opinion: "评估报告齐全。", submittedAt: "09-25 11:22" }
];

export const demoTraces: Trace[] = [
  { id: "trc-8f31a2", caller: "运营监测应用", capability: "资源状态查询 API", path: "/api/v2/resources/G4-1077/status", status: 200, latencyMs: 42, at: "10:42:18" },
  { id: "trc-7c20b5", caller: "客户门户", capability: "客户主数据同步", path: "/api/v2/customers/G4-1077", status: 200, latencyMs: 88, at: "10:41:55" },
  { id: "trc-6d94e8", caller: "智能客服", capability: "工单意图识别 Skill", path: "/ai/v1/tickets/intent", status: 200, latencyMs: 126, at: "10:41:30" },
  { id: "trc-5a17c3", caller: "运营监测应用", capability: "资源状态查询 API", path: "/api/v2/resources/G4-2013/status", status: 200, latencyMs: 39, at: "10:40:58" },
  { id: "trc-4e88f0", caller: "计费归档作业", capability: "计费明细数据源", path: "datasource: billing.daily", status: 200, latencyMs: 210, at: "10:39:12" },
  { id: "trc-3b55a7", caller: "外部联调方", capability: "客户主数据同步", path: "/api/v2/customers/sync", status: 403, latencyMs: 12, at: "10:38:47" }
];

export const demoUsers: DemoUser[] = [
  { name: "林一舟", account: "lin.yizhou", role: "系统管理员", org: "平台治理组", status: "启用" },
  { name: "李澄", account: "li.cheng", role: "能力使用者", org: "应用集成组", status: "启用", override: "资源状态查询 API：只读" },
  { name: "王澜", account: "wang.lan", role: "能力录入者", org: "数据服务部", status: "启用" },
  { name: "赵禾", account: "zhao.he", role: "能力运营者", org: "平台运营部", status: "启用" },
  { name: "访客演示", account: "guest.demo", role: "访客", org: "外部", status: "停用" }
];

export const demoUsageByDay = [
  { day: "周一", calls: 8_420, failures: 31 },
  { day: "周二", calls: 9_150, failures: 24 },
  { day: "周三", calls: 8_970, failures: 19 },
  { day: "周四", calls: 10_240, failures: 42 },
  { day: "周五", calls: 11_680, failures: 28 },
  { day: "周六", calls: 6_310, failures: 12 },
  { day: "周日", calls: 5_890, failures: 9 }
];

export const demoActivity = [
  { at: "10:42", text: "运营监测应用 调用 资源状态查询 API 成功（trc-8f31a2）" },
  { at: "10:31", text: "王澜 提交 客户主数据同步 v2.4 变更申请" },
  { at: "10:05", text: "系统完成 网关策略 日常巡检，双节点健康" },
  { at: "09:47", text: "李澄 续订 资源状态查询 API 订阅（G4 范围）" },
  { at: "09:12", text: "密钥轮换提醒：运营监测应用凭证将于 14 天后到期" }
];

export const demoProtocolShare = [
  { label: "REST API", value: 62 },
  { label: "Kafka", value: 18 },
  { label: "AI Skill", value: 12 },
  { label: "数据源", value: 8 }
];

// ---- mutable demo state --------------------------------------------------------

const SESSION_KEY = "showit-demo-session";

export type DemoSession = {
  account: string;
  name: string;
  role: string;
  loggedInAt: number;
};

export function readDemoSession(): DemoSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) as DemoSession : null;
  } catch {
    return null;
  }
}

export function writeDemoSession(session: DemoSession | null): void {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage may be unavailable; the demo degrades to per-render state.
  }
}

/** In-memory mutations — persist for the tab lifetime only.
 *
 * Contexts: the interactive demo page OWNS these (user gestures); the
 * audience mirror APPLIES a replicated copy so published/approved state
 * stays in sync across documents (each page is its own JS context). */
export const demoMutations = {
  published: new Set<string>(),
  offlined: new Set<string>(),
  approved: new Set<string>(),
  quotas: new Map<string, number>()
};

export type DemoMutation =
  | { kind: "publish"; assetId: string }
  | { kind: "offline"; assetId: string }
  | { kind: "approve"; approvalId: string }
  | { kind: "quota"; assetId: string; value: number };

/** Mutations applied in this document, in order.
 *
 * Kept so the interactive console can replay them after its port drops: a
 * service worker restart used to strand the audience mirror on stale data,
 * because the page still looks right locally (it mutates in memory). */
export const appliedMutations: DemoMutation[] = [];

export function applyDemoMutation(mutation: DemoMutation): void {
  if (mutation.kind === "publish") {
    demoMutations.published.add(mutation.assetId);
    demoMutations.offlined.delete(mutation.assetId);
  } else if (mutation.kind === "offline") {
    demoMutations.offlined.add(mutation.assetId);
    demoMutations.published.delete(mutation.assetId);
  } else if (mutation.kind === "approve") {
    demoMutations.approved.add(mutation.approvalId);
  } else {
    demoMutations.quotas.set(mutation.assetId, Math.round(Math.min(6_000, Math.max(10, mutation.value))));
  }
  appliedMutations.push(mutation);
  if (appliedMutations.length > 100) appliedMutations.shift();
}

export function assetLifecycle(asset: RegistryAsset): RegistryAsset["lifecycle"] {
  if (demoMutations.offlined.has(asset.id)) return "已下线";
  if (demoMutations.published.has(asset.id)) return "运行中";
  return asset.lifecycle;
}

export function approvalStatus(approval: Approval): Approval["status"] {
  if (demoMutations.approved.has(approval.id)) return "已通过";
  return approval.status;
}

export function demoQuotaSave(id: string, value: number): void {
  demoMutations.quotas.set(id, value);
}

export function assetQuota(asset: RegistryAsset): number {
  return demoMutations.quotas.get(asset.id) ?? asset.quota;
}

export function registryAssets(): RegistryAsset[] {
  return demoRegistryAssets.map((asset) => ({
    ...asset,
    lifecycle: assetLifecycle(asset),
    quota: assetQuota(asset)
  }));
}

export function approvals(): Approval[] {
  return demoApprovals.map((approval) => ({ ...approval, status: approvalStatus(approval) }));
}
