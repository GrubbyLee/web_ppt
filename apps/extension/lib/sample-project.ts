import type { PresentationPage, PresentationSession, PresentationStep, Project, RecordedAction } from "@showit/contracts";
import { canonicalValue } from "./project-workspace";

/**
 * Built-in sample: 「云枢 · 五角色能力治理闭环」.
 *
 * The business system is the extension's own demo console (demo:// views —
 * see lib/demo/). Everything runs offline inside the product: the login step
 * exercises sensitive variables, the publish step is high-risk, searches and
 * approvals verify conditions, and one page carries an offline fallback.
 */

type SeedStep = {
  say?: string;
  act?: string;
  expected?: string;
  action?: {
    type: "click" | "fill";
    testid: string;
    label?: string;
    value?: string;
    sensitiveKey?: string;
  };
  condition?: { element?: string; text?: string };
  execution?: "hint" | "highlight" | "assist" | "auto";
  risk?: "normal" | "high";
  autoContinue?: boolean;
};

type SeedPage = {
  id: string;
  title: string;
  section: string;
  role: string;
  businessLabel: string;
  minutes: number;
  purpose: string;
  talk: string[];
  transition: string;
  cue: string;
  fallback: string;
  /** demo:// view for live pages; chapters and closing render as stage slides. */
  view?: string;
  offlineHtml?: string;
  steps?: SeedStep[];
};

const seedPages: SeedPage[] = [
  {
    id: "cover",
    title: "云枢 · 五角色能力治理闭环",
    section: "开场",
    role: "系统管理员",
    businessLabel: "平台指挥台",
    minutes: 0.7,
    purpose: "建立产品定位、演示范围和现场预期",
    talk: [
      "今天用五个角色说明能力开放与 API 治理平台的完整闭环。",
      "演示沿着真实业务链展开，而不是逐项朗读菜单。",
      "涉及客户外部平台时，会明确说明联合部署与联调边界。"
    ],
    transition: "先看今天的目录和五个角色之间的关系。",
    cue: "确认观众屏已同步；系统状态应显示角色就绪。",
    fallback: "观众屏未同步时，先保留系统屏并重新打开观众窗口。"
  },
  {
    id: "agenda-role-map",
    title: "目录与五角色地图",
    section: "开场",
    role: "系统管理员",
    businessLabel: "五角色工作区总览",
    minutes: 1,
    purpose: "让混合听众先知道谁在何时使用系统",
    talk: [
      "访客负责发现，能力使用者负责接入，能力录入者负责资产沉淀。",
      "能力运营者负责审批和运行治理，系统管理员负责组织、权限和流程。"
    ],
    transition: "进入角色之前，先说明产品合同与底层实现之间的边界。",
    cue: "指向完整治理闭环，不在本页展开功能细节。",
    fallback: "时间不足时只读每个角色的第一动词：发现、接入、录入、运营、治理。"
  },
  {
    id: "product-positioning",
    title: "云枢产品与实现边界",
    section: "产品定位",
    role: "系统管理员",
    businessLabel: "平台管理",
    minutes: 1.2,
    purpose: "说明客户使用的是稳定产品合同，而非某一种底层实现",
    talk: [
      "客户直接使用的是统一设计的产品面、角色工作区和状态机。",
      "API 管理、订阅、生命周期、工作流和网关能力通过适配层统一接入。",
      "客户看到的是稳定业务合同，而不是基础软件的原始字段与异常。"
    ],
    transition: "边界明确后，再看业务对象如何穿过五种角色。",
    cue: "先指产品面，再指实现层；强调复用能力，不复制页面。",
    fallback: "说明生产接入前会核对现有系统的 API、权限范围和响应字段。"
  },
  {
    id: "cross-role-lifecycle",
    title: "跨角色业务主线",
    section: "产品定位",
    role: "系统管理员",
    businessLabel: "治理运行态势",
    minutes: 1.4,
    purpose: "建立整场演示的端到端叙事坐标",
    talk: [
      "能力录入者创建并验证资产，能力运营者审批发布并决定生效规则。",
      "发布后的能力进入目录，使用者申请订阅并发起调用。",
      "同一个业务编号、状态和 Trace 能贯穿申请、审批、生效、调用与审计。"
    ],
    transition: "先从最轻量的入口，也就是访客视角开始。",
    cue: "沿时间线从左向右指读五个节点。",
    fallback: "只强调谁提交、谁审批、何时生效、出问题如何追踪。"
  },
  {
    id: "visitor-chapter",
    title: "角色一：访客",
    section: "访客",
    role: "访客",
    businessLabel: "能力门户",
    minutes: 0.3,
    purpose: "切换到公开能力发现阶段",
    talk: ["访客不进入管理面，也能快速找到可信、可理解、可接入的能力。"],
    transition: "现在登录演示账号，看公开门户如何承接这件事。",
    cue: "准备在下一页输入演示密码（敏感变量），观众画面会自动进入隐私保护。",
    fallback: "角色切换失败时，继续使用只读页面讲解。"
  },
  {
    id: "visitor-live-demo",
    title: "访客：登录与能力发现",
    section: "访客",
    role: "访客",
    businessLabel: "能力市场",
    minutes: 2,
    purpose: "演示敏感变量登录与公开能力发现（搜索、详情、接入流程）",
    talk: [
      "登录密码来自演示启动时输入的敏感变量：它只存在于浏览器内存，浏览器关闭即清除。",
      "填写密码期间，观众画面自动进入隐私保护；完成后自动恢复。",
      "访客只看到门户、能力市场与文档中心，没有管理菜单。"
    ],
    transition: "发现能力以后，下一步是用受控的应用身份来消费它。",
    cue: "依次执行填写账号、填写密码、登录三个步骤；随后搜索“资源状态”。",
    fallback: "使用离线画面说明公开门户，避免反复刷新。",
    view: "marketplace",
    offlineHtml: "<main style=\"font-family:system-ui;padding:48px;max-width:720px;margin:0 auto;color:#1c2333\"><h1>云枢 · 能力门户（离线备用）</h1><p>门户当前展示 36 项已上架能力，支持按名称、类型与提供方搜索。</p><ul><li>资源状态查询 API（REST · 平台运营部）</li><li>客户主数据同步（REST · 数据服务部）</li><li>工单意图识别 Skill（AI · 智能服务部）</li></ul><p>网络恢复后，本页会自动回到在线门户。</p></main>",
    steps: [
      { say: "说明演示账号与敏感变量的边界。" },
      {
        act: "填写演示账号。",
        expected: "账号输入完成。",
        action: { type: "fill", testid: "login-username", value: "demo@cloudpivot.cn", label: "演示账号" },
        condition: { element: "login-submit" },
        execution: "auto"
      },
      {
        act: "填写演示密码（敏感变量）。",
        expected: "密码输入期间观众画面进入隐私保护。",
        action: { type: "fill", testid: "login-password", sensitiveKey: "demoPassword", label: "演示密码" },
        condition: { element: "login-submit" },
        execution: "auto"
      },
      {
        act: "点击登录进入能力市场。",
        expected: "进入市场后出现搜索框。",
        action: { type: "click", testid: "login-submit", label: "登录" },
        condition: { element: "market-search" },
        execution: "auto"
      },
      { say: "确认公开工作区：没有管理菜单。" },
      {
        act: "在市场搜索“资源状态”。",
        expected: "搜索词已写入。",
        action: { type: "fill", testid: "market-search", value: "资源状态", label: "能力搜索" },
        condition: { element: "market-search-btn" },
        execution: "auto",
        autoContinue: true
      },
      {
        act: "执行搜索。",
        expected: "结果中出现资源状态查询 API。",
        action: { type: "click", testid: "market-search-btn", label: "搜索" },
        condition: { text: "资源状态查询" },
        execution: "auto"
      },
      {
        act: "打开能力详情。",
        expected: "显示版本、提供方与接入流程。",
        action: { type: "click", testid: "market-card-resource-status", label: "资源状态查询 API" },
        condition: { element: "market-detail" },
        execution: "auto"
      }
    ]
  },
  {
    id: "consumer-chapter",
    title: "角色二：能力使用者",
    section: "能力使用者",
    role: "能力使用者",
    businessLabel: "应用与凭证",
    minutes: 0.3,
    purpose: "切换到应用、订阅和调用阶段",
    talk: ["平台不仅交付地址，还要把应用身份、授权范围、凭证生命周期和调用证据一起交付。"],
    transition: "通过既有订阅和调用记录查看完整消费链。",
    cue: "进入订阅中心。",
    fallback: "切换失败时用只读页面说明应用身份和资源范围。"
  },
  {
    id: "consumer-live-demo",
    title: "能力使用者：订阅与调用证据",
    section: "能力使用者",
    role: "能力使用者",
    businessLabel: "订阅中心",
    minutes: 2.4,
    purpose: "用应用身份、订阅、资源范围、用量和 Trace 说明消费闭环",
    talk: [
      "运营监测应用代表独立调用身份，Secret 默认脱敏，本次不执行轮换。",
      "资源状态查询 API 已绑定到应用，并带有 G4 示例资源范围。",
      "调用用量与 Trace 来自后台读取模型，本次演示全程只读。"
    ],
    transition: "消费链路跑通以后，回到能力的供给侧。",
    cue: "依次查看应用身份、订阅状态与用量图表。",
    fallback: "用量读取失败时，展示带 Trace ID 的错误卡并回到订阅详情。",
    view: "subscriptions",
    steps: [
      { say: "确认调用身份与安全边界。" },
      {
        act: "查看应用身份与脱敏凭证。",
        expected: "凭证显示为 AK**** 前缀。",
        action: { type: "click", testid: "app-identity", label: "应用身份" },
        condition: { element: "app-identity" },
        execution: "auto"
      },
      {
        act: "确认订阅运行状态。",
        expected: "资源状态查询 API 处于运行中。",
        action: { type: "click", testid: "sub-status-running", label: "订阅状态" },
        condition: { element: "sub-status-running" },
        execution: "auto"
      },
      { say: "讲解用量图表与成功率，不发送请求。" }
    ]
  },
  {
    id: "producer-chapter",
    title: "角色三：能力录入者",
    section: "能力录入者",
    role: "能力录入者",
    businessLabel: "能力工作室",
    minutes: 0.3,
    purpose: "切换到能力供给与生命周期阶段",
    talk: ["能力录入者把后端服务、工具、事件或数据源沉淀成可治理的资产。"],
    transition: "先看平台统一承接哪些能力形态。",
    cue: "进入能力工作室。",
    fallback: "继续在只读页面讲解资产类型和合同。"
  },
  {
    id: "capability-types",
    title: "五种录入方式与统一治理",
    section: "能力录入者",
    role: "能力录入者",
    businessLabel: "接口与工具配置",
    minutes: 1,
    purpose: "解释录入方式与最终资产类型之间的关系",
    talk: [
      "能力工作室提供 API、MCP、AI Skill、Kafka 和数据源五种录入方式。",
      "最终资产共享分类、权限、版本、审批、发布和审计合同。"
    ],
    transition: "下面进入真实资产，看从端点验证到生命周期的操作。",
    cue: "按录入方式指读，最后强调统一治理。",
    fallback: "客户只关心 API 时，保留资产类型和统一治理的结论。",
    view: "studio",
    steps: [
      { say: "讲解五种录入方式的适用场景。" },
      {
        act: "查看统一录入入口。",
        expected: "五种录入方式全部可见。",
        action: { type: "click", testid: "studio-cards", label: "录入方式" },
        condition: { element: "studio-cards" },
        execution: "auto"
      }
    ]
  },
  {
    id: "producer-live-demo",
    title: "能力录入者：资产与生命周期",
    section: "能力录入者",
    role: "能力录入者",
    businessLabel: "资产目录",
    minutes: 2.4,
    purpose: "演示资产详情、配额与高风险发布确认",
    talk: [
      "资产目录中的运维助手 MCP 处于待发布状态。",
      "发布已上架资产属于高风险变更：控制台会要求显式确认。",
      "发布后生命周期转为运行中，并进入运营者的审批与审计视野。"
    ],
    transition: "高风险变化提交后，责任交到能力运营者。",
    cue: "先打开待发布资产详情，再执行高风险发布步骤。",
    fallback: "用离线画面说明已上架资源和生命周期边界。",
    view: "registry",
    steps: [
      { say: "查看资产目录与状态筛选。" },
      {
        act: "打开待发布资产“运维助手 MCP”。",
        expected: "右侧出现资产详情。",
        action: { type: "click", testid: "registry-row-asset-ops-copilot", label: "运维助手 MCP" },
        condition: { element: "api-detail" },
        execution: "auto"
      },
      {
        act: "发布运维助手 MCP（高风险）。",
        expected: "控制台弹出高风险确认；发布后生命周期为运行中。",
        action: { type: "click", testid: "publish-api", label: "发布能力" },
        condition: { element: "api-status-running" },
        execution: "auto",
        risk: "high"
      },
      { say: "说明发布与审批、审计的联动。" }
    ]
  },
  {
    id: "operator-chapter",
    title: "角色四：能力运营者",
    section: "能力运营者",
    role: "能力运营者",
    businessLabel: "运营指挥台",
    minutes: 0.3,
    purpose: "切换到审批、网关和运行运营阶段",
    talk: ["能力运营者判断什么变化可以生效，并把决定连接到运行策略。"],
    transition: "先处理真实变更申请，再回查运行证据。",
    cue: "进入审批队列。",
    fallback: "用只读审批页讲解状态机，不提交审批。"
  },
  {
    id: "operator-approval-demo",
    title: "能力运营者：变更审批",
    section: "能力运营者",
    role: "能力运营者",
    businessLabel: "审批队列",
    minutes: 2,
    purpose: "演示审批动作与状态机验证",
    talk: [
      "审批队列中的变更申请是带业务编号、资源、申请人和意见的状态机。",
      "本次演示会真实通过一条变更申请；审批意见是审计输入。",
      "结果会继续驱动生效、通知与版本动作。"
    ],
    transition: "审批决定变化能否进入线上，下一页看网关如何执行。",
    cue: "执行“通过”步骤并观察状态从待审批变为已通过。",
    fallback: "目标申请已处理时，选择其他现有申请查看。",
    view: "approvals",
    steps: [
      { say: "定位审批输入：资源、申请人和意见。" },
      {
        act: "通过“客户主数据同步 v2.4 变更申请”。",
        expected: "状态从待审批变为已通过。",
        action: { type: "click", testid: "approve-order", label: "通过" },
        condition: { element: "approval-status-approved" },
        execution: "auto"
      },
      { say: "说明后续动作：生效、通知与审计。" }
    ]
  },
  {
    id: "operator-runtime-demo",
    title: "能力运营者：运行治理",
    section: "能力运营者",
    role: "能力运营者",
    businessLabel: "运行洞察",
    minutes: 2.2,
    purpose: "说明网关、Trace、节点、告警与集成状态的统一运营",
    talk: [
      "从最近调用中可以用 Trace ID 串起调用方、能力、路径、状态码和耗时。",
      "路由、配额、熔断、脱敏和安全规则由后端强制执行。",
      "节点与外部适配器均在同一运营面展示，本次不做生产变更。"
    ],
    transition: "运行治理解决线上行为，最后还需要管理员定义组织边界。",
    cue: "依次查看最近调用、网关策略与节点健康。",
    fallback: "Trace 查询失败时，保留错误卡并转到节点健康页。",
    view: "operations",
    steps: [
      { say: "查看调用证据：200 与 Trace ID。" },
      {
        act: "查看最近调用列表。",
        expected: "Trace 表格可见。",
        action: { type: "click", testid: "trace-table", label: "最近调用" },
        condition: { element: "trace-table" },
        execution: "auto"
      },
      {
        act: "查看网关策略。",
        expected: "QPS、配额与脱敏规则可见。",
        action: { type: "click", testid: "gateway-policy", label: "网关策略" },
        condition: { element: "gateway-policy" },
        execution: "auto"
      },
      {
        act: "检查网关节点。",
        expected: "双节点健康。",
        action: { type: "click", testid: "node-health", label: "网关节点" },
        condition: { element: "node-health" },
        execution: "auto"
      }
    ]
  },
  {
    id: "administrator-chapter",
    title: "角色五：系统管理员",
    section: "系统管理员",
    role: "系统管理员",
    businessLabel: "平台管理",
    minutes: 0.3,
    purpose: "切换到组织级身份、权限和流程治理",
    talk: ["系统管理员把用户、角色、菜单、权限覆盖和审批流程变成可管理、可审计的合同。"],
    transition: "现在看同一个登录入口如何返回不同角色和菜单。",
    cue: "进入权限与流程。",
    fallback: "用只读页面讲解，不修改用户状态。"
  },
  {
    id: "administrator-live-demo",
    title: "系统管理员：身份与流程",
    section: "系统管理员",
    role: "系统管理员",
    businessLabel: "权限与流程",
    minutes: 2,
    purpose: "说明角色菜单合同、细粒度权限和流程版本由后台管理",
    talk: [
      "用户绑定组织、角色与状态，也可以配置细粒度权限覆盖。",
      "角色模板、密钥状态、通知模板和审计都属于组织级控制项。",
      "已发布订阅流程有能力录入者和能力运营者两个节点。"
    ],
    transition: "五种角色都看完以后，用最后一张架构图解释稳定边界。",
    cue: "依次查看角色模板、密钥状态与已发布流程。",
    fallback: "用离线画面说明用户、角色和已发布流程。",
    view: "admin-controls",
    steps: [
      { say: "查看用户与组织、角色模板。" },
      {
        act: "查看密钥脱敏状态。",
        expected: "密钥以 SK**** / AK**** 形式展示。",
        action: { type: "click", testid: "keys-masked", label: "密钥状态" },
        condition: { element: "keys-masked" },
        execution: "auto"
      },
      {
        act: "查看已发布审批流程。",
        expected: "显示两个已发布节点。",
        action: { type: "click", testid: "workflow-nodes", label: "已发布流程" },
        condition: { element: "workflow-nodes" },
        execution: "auto"
      }
    ]
  },
  {
    id: "architecture-boundary",
    title: "架构与集成边界",
    section: "架构边界",
    role: "系统管理员",
    businessLabel: "平台接口目录",
    minutes: 1.8,
    purpose: "向技术听众说明稳定合同、安全控制和部署替换方式",
    talk: [
      "前端只访问产品合同，不直接依赖基础软件页面路由、内部数据库或原始异常。",
      "适配层负责字段映射、权限、脱敏、幂等、Trace 与错误归一化。",
      "交付的是稳定产品边界，而不是基础软件的重新包装。"
    ],
    transition: "最后用三个结论收束今天的演示。",
    cue: "按前端合同、适配编排、运行时与外部系统三层说明。",
    fallback: "技术讨论时间不足时，只讲三层边界。"
  },
  {
    id: "closing",
    title: "收束与问答",
    section: "收束",
    role: "系统管理员",
    businessLabel: "平台指挥台",
    minutes: 0.8,
    purpose: "留下统一目录、全程治理和稳定边界三个记忆点",
    talk: [
      "一个目录承接多种能力形态。",
      "从申请到运行和审计是一条连续治理链。",
      "客户可见产品合同与底座实现彼此隔离。"
    ],
    transition: "结束演示，进入问答。",
    cue: "停顿两秒，保留本页或切回封面。",
    fallback: "时间超出时，直接读三条结论进入问答。"
  }
];

function toRecordedAction(step: SeedStep): RecordedAction | undefined {
  const action = step.action;
  if (!action) return undefined;
  if (action.type === "click") {
    return { type: "click", locator: { strategy: "testid", value: action.testid }, ...(action.label ? { label: action.label } : {}) };
  }
  return {
    type: "fill",
    locator: { strategy: "testid", value: action.testid },
    input: action.sensitiveKey
      ? { source: "sensitive", key: action.sensitiveKey }
      : { source: "fixed", value: action.value ?? "" },
    ...(action.label ? { label: action.label } : {})
  };
}

function createSteps(page: SeedPage): PresentationStep[] {
  if (!page.steps) {
    return [
      { id: `${page.id}-say-1`, kind: "say", text: page.talk[0] ?? page.purpose, execution: "hint", conditionTimeoutSeconds: 8, risk: "normal", autoContinue: false, presenterOnly: false },
      { id: `${page.id}-transition`, kind: "transition", text: page.transition, execution: "hint", conditionTimeoutSeconds: 8, risk: "normal", autoContinue: false, presenterOnly: false }
    ];
  }
  return page.steps.flatMap((step, index): PresentationStep[] => {
    const base = {
      conditionTimeoutSeconds: 8,
      risk: (step.risk ?? "normal") as "normal" | "high",
      autoContinue: step.autoContinue === true,
      presenterOnly: false
    };
    if (step.say !== undefined) {
      return [{ id: `${page.id}-say-${index + 1}`, kind: "say" as const, text: step.say, execution: "hint" as const, ...base }];
    }
    const recordedAction = toRecordedAction(step);
    return [{
      id: `${page.id}-act-${index + 1}`,
      kind: "act" as const,
      text: step.act ?? "",
      ...(step.expected ? { expected: step.expected } : {}),
      execution: (step.execution ?? "hint") as PresentationStep["execution"],
      ...(recordedAction ? { recordedAction } : {}),
      ...(step.condition?.element ? { expectedCondition: { type: "element" as const, locator: { strategy: "testid" as const, value: step.condition.element } } } : {}),
      ...(step.condition?.text ? { expectedCondition: { type: "text" as const, value: step.condition.text } } : {}),
      ...base
    }];
  });
}

function toMarkdown(page: SeedPage): string {
  return [
    "## 现场讲述",
    ...page.talk.map((paragraph) => paragraph),
    "",
    "## 转场",
    page.transition,
    "",
    "## 舞台提示",
    page.cue,
    "",
    "## 异常处理",
    page.fallback
  ].join("\n\n");
}

function createPage(page: SeedPage, order: number): PresentationPage {
  const isEnd = page.id === "closing";
  return {
    id: page.id,
    order,
    pageType: isEnd ? "end" : page.view ? "business" : "fixed",
    enabled: true,
    title: page.title,
    section: page.section,
    tags: [page.role],
    purpose: page.purpose,
    transitionNote: page.transition,
    errorHandling: page.fallback,
    role: page.role,
    businessLabel: page.businessLabel,
    ...(page.view ? { url: `demo://${page.view}` } : {}),
    variables: [],
    privacyMasks: [],
    estimatedSeconds: Math.round(page.minutes * 60),
    autoAdvanceSeconds: Math.round(page.minutes * 60),
    ...(page.offlineHtml ? { offline: { kind: "html" as const, content: page.offlineHtml, resources: [], allowedNetworkOrigins: [] } } : {}),
    script: {
      markdown: toMarkdown(page),
      steps: createSteps(page),
      fallback: page.fallback
    }
  };
}

export const sampleProject: Project = {
  id: "lc-apim-five-role-demo",
  formatVersion: 1,
  name: "云枢 · 五角色能力治理闭环",
  description: "Showit 内置示例：业务系统为扩展内置的“云枢能力开放平台”演练控制台，完全离线运行，可删除、可复制。",
  status: "draft",
  totalPlannedSeconds: 1_560,
  autoAdvanceEnabled: false,
  autoAdvanceSeconds: 90,
  audienceJoinMode: "direct",
  audienceCapacityMode: "p2p-5",
  browserSessionMode: "daily",
  variables: [],
  sensitiveVariables: [
    { key: "demoPassword", label: "演示账号密码", description: "云枢演示控制台的登录密码，仅在演示期间存在于浏览器内存。", required: true, expiresAfterMinutes: 60 }
  ],
  brand: {
    primaryColor: "#37d0ba",
    statusBackgroundColor: "#172533",
    privacyMessage: "演示准备中",
    loadingMessage: "正在加载云枢业务画面",
    offlineLabel: "云枢离线备用",
    endTitle: "演示结束",
    endDescription: "感谢观看五角色治理闭环演示",
    audienceTitle: "云枢演示观众屏"
  },
  layout: {
    stagePercent: 56,
    preset: "stage",
    noteFontScale: 1
  },
  connectors: [],
  pages: seedPages.map(createPage)
};

// ---- bundled-sample migration chain --------------------------------------------
// Users who never touched an older bundled sample are upgraded in place
// (same project id, so the IndexedDB record is overwritten).

const legacyLcapimSample: Project = {
  ...sampleProject,
  name: "LCAPIM 五角色治理闭环",
  description: "Showit 内置示例。来源于 LCAPIM 现有演示的可删除、可复制迁移版本。",
  sensitiveVariables: [],
  brand: { ...sampleProject.brand, loadingMessage: "正在加载 LCAPIM 业务画面", offlineLabel: "LCAPIM 离线备用", endTitle: "LCAPIM 演示结束", audienceTitle: "LCAPIM 演示观众屏" },
  connectors: [{
    id: "lc-apim-local",
    name: "LCAPIM 本机只读连接器",
    origin: "http://localhost:3001",
    mode: "iframe",
    permission: "assist",
    securityMode: "readonly-proxy",
    environment: "本机黄金样例",
    requestHeaders: [],
    basicAuthInstructions: "如需登录，请在业务浏览器中完成本机账号登录。",
    loginPaths: ["/api/lc/v1/auth/login"],
    logoutPaths: ["/api/lc/v1/session/logout"],
    roleSwitchPaths: [],
    sessionProbe: {
      path: "/api/lc/v1/session/status",
      userPath: ["data", "user"],
      primaryRoleField: "role",
      rolesField: "roles",
      roleMappings: [
        { presentationRole: "访客", connectorRole: "guest" },
        { presentationRole: "能力使用者", connectorRole: "consumer" },
        { presentationRole: "能力录入者", connectorRole: "producer" },
        { presentationRole: "能力运营者", connectorRole: "operator" },
        { presentationRole: "系统管理员", connectorRole: "admin" }
      ]
    },
    sandboxPermissions: ["allow-scripts", "allow-same-origin"],
    allowedOrigins: ["http://localhost:3001"]
  }],
  pages: sampleProject.pages.map((page) => ({
    ...page,
    pageType: page.id === "closing" ? "end" as const : "business" as const,
    url: `http://localhost:3001/console/?view=${({
      cover: "overview",
      "agenda-role-map": "overview",
      "product-positioning": "admin",
      "cross-role-lifecycle": "overview",
      "visitor-chapter": "portal",
      "visitor-live-demo": "marketplace",
      "consumer-chapter": "applications",
      "consumer-live-demo": "subscriptions",
      "producer-chapter": "studio",
      "capability-types": "studio-details",
      "producer-live-demo": "registry",
      "operator-chapter": "overview",
      "operator-approval-demo": "approvals",
      "operator-runtime-demo": "operations",
      "administrator-chapter": "admin",
      "administrator-live-demo": "admin-controls",
      "architecture-boundary": "admin",
      closing: "overview"
    } as Record<string, string>)[page.id] ?? "overview"}`,
    connectorId: "lc-apim-local"
  }))
};

const legacyV1Sample: Project = {
  ...legacyLcapimSample,
  connectors: legacyLcapimSample.connectors.map((connector) => connector.id === "lc-apim-local" ? {
    ...connector,
    origin: "http://localhost:3000",
    mode: "extension" as const,
    allowedOrigins: ["http://localhost:3000"],
    loginPaths: ["/login", "/sso"],
    logoutPaths: ["/logout"],
    roleSwitchPaths: [],
    sessionProbe: undefined
  } : connector),
  pages: legacyLcapimSample.pages.map((page) => ({
    ...page,
    url: `http://localhost:3000/docs/demo/lc-apim-customer-demo/index.html?mode=presenter&showitPage=${page.id}`
  }))
};

const priorBundledSample: Project = {
  ...legacyLcapimSample,
  connectors: legacyLcapimSample.connectors.map((connector) => connector.id === "lc-apim-local"
    ? { ...connector, sessionProbe: undefined }
    : connector)
};

/** Only replace the exact bundled samples; user changes are intentionally preserved. */
export function migrateLegacyBundledSample(project: Project): Project | null {
  const serialized = JSON.stringify(canonicalValue(project));
  const isUntouchedBundledProject = serialized === JSON.stringify(canonicalValue(legacyV1Sample))
    || serialized === JSON.stringify(canonicalValue(priorBundledSample))
    || serialized === JSON.stringify(canonicalValue(legacyLcapimSample));
  if (project.id !== sampleProject.id || !isUntouchedBundledProject) return null;
  return structuredClone(sampleProject);
}

export const sampleSession: PresentationSession = {
  id: "session-lc-apim-local",
  projectId: sampleProject.id,
  currentPageIndex: 0,
  completedStepIds: [],
  forcedStepCompletions: [],
  timerStatus: "idle",
  totalElapsedMs: 0,
  pageElapsedMs: 0,
  sectionElapsedMs: 0,
  timerStartedAt: null,
  autoAdvanceElapsedMs: 0,
  autoAdvanceStartedAt: null,
  screenMode: "normal",
  offlineFallbackPageId: null,
  offlineNetworkGrants: [],
  pendingHighRiskStepId: null,
  browserSessionMode: "daily",
  annotationTool: "none",
  circles: [],
  circlesByPage: {},
  laser: null,
  audienceStatus: "disconnected",
  audienceCount: 0,
  sequence: 0
};
