import type { PresentationPage, PresentationSession, PresentationStep, Project } from "@showit/contracts";

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
  steps?: Array<{ say: string; action?: string; expected?: string }>;
};

const seedPages: SeedPage[] = [
  {
    id: "cover",
    title: "LCAPIM 五角色治理闭环",
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
    title: "LCAPIM 产品与实现边界",
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
    transition: "现在切到系统，看公开门户如何承接这件事。",
    cue: "切换访客浏览角色，返回 Showit 后刷新业务画面。",
    fallback: "角色切换失败时，继续使用只读页面讲解。"
  },
  {
    id: "visitor-live-demo",
    title: "访客：门户与能力发现",
    section: "访客",
    role: "访客",
    businessLabel: "能力市场",
    minutes: 1.4,
    purpose: "证明公开目录、搜索和详情来自真实接口且遵守权限边界",
    talk: [
      "访客只看到门户、能力市场、解决方案和文档中心，没有管理菜单。",
      "搜索资源状态查询 API 后，可以看到能力类型、描述、版本和提供方。",
      "发现阶段只解决能不能找到和理解，订阅需要切换到能力使用者。"
    ],
    transition: "发现能力以后，下一步是用受控的应用身份来消费它。",
    cue: "进入能力市场，搜索资源状态查询 API，查看详情但不申请订阅。",
    fallback: "使用离线画面说明公开门户，避免反复刷新。",
    steps: [
      { say: "确认公开工作区。", action: "打开能力市场。", expected: "没有管理菜单。" },
      { say: "搜索一项真实能力。", action: "查询资源状态 API。", expected: "显示类型、描述和上架状态。" },
      { say: "查看公开详情。", action: "打开搜索结果。", expected: "看到版本、提供方和使用流程。" }
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
    cue: "切换开发者角色并刷新。",
    fallback: "切换失败时用只读页面说明应用身份和资源范围。"
  },
  {
    id: "consumer-live-demo",
    title: "能力使用者：订阅与调用证据",
    section: "能力使用者",
    role: "能力使用者",
    businessLabel: "订阅中心",
    minutes: 3,
    purpose: "用真实后台数据证明应用、订阅、资源范围、用量和 Trace 形成闭环",
    talk: [
      "运营监测应用代表独立调用身份，Secret 默认脱敏，本次不执行轮换。",
      "资源状态查询 API 已绑定到应用，并带有 G4 示例资源范围。",
      "调用用量与 Trace 来自后台读取模型，本次演示全程只读。"
    ],
    transition: "消费链路跑通以后，回到能力的供给侧。",
    cue: "依次展示应用与凭证、订阅中心和调用用量，不发送请求。",
    fallback: "用量读取失败时，展示带 Trace ID 的错误卡并回到订阅详情。",
    steps: [
      { say: "确认调用身份与安全边界。", action: "打开运营监测应用。", expected: "凭证、Scope 和白名单都已脱敏。" },
      { say: "确认订阅关系。", action: "打开资源状态查询 API。", expected: "状态运行中，范围含 G4。" },
      { say: "查看调用证据。", action: "切换到调用用量。", expected: "有成功率和按能力统计。" }
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
    cue: "切换能力录入者角色并刷新。",
    fallback: "继续在只读页面讲解资产类型和合同。"
  },
  {
    id: "capability-types",
    title: "五种录入方式与四类资产",
    section: "能力录入者",
    role: "能力录入者",
    businessLabel: "接口与工具配置",
    minutes: 1,
    purpose: "解释录入方式与最终资产类型之间的关系",
    talk: [
      "能力工作室提供 API、MCP、AI Skill、Kafka 和数据源 API 五种录入方式。",
      "最终资产共享分类、权限、版本、审批、发布和审计合同。"
    ],
    transition: "下面进入真实资产，看从端点验证到生命周期的操作。",
    cue: "按录入方式指读，最后强调统一治理。",
    fallback: "客户只关心 API 时，保留四类资产和统一治理的结论。"
  },
  {
    id: "producer-live-demo",
    title: "能力录入者：资产与生命周期",
    section: "能力录入者",
    role: "能力录入者",
    businessLabel: "资产目录",
    minutes: 2.7,
    purpose: "证明能力资产、双环境、健康检查和变更流程真实存在",
    talk: [
      "能力工作室提供不同录入方式，本次不创建临时草稿。",
      "资源状态查询 API 的合同、环境、健康检查、错误码和文档同属一项资产。",
      "已上架资产的高风险变更需要审批并保留版本历史。"
    ],
    transition: "高风险变化提交后，责任交到能力运营者。",
    cue: "展示能力工作室、资产目录、发布与生命周期，不创建和维护资产。",
    fallback: "用离线画面说明已上架资源和生命周期边界。",
    steps: [
      { say: "查看统一录入入口。", action: "展开能力工作室。", expected: "显示五种录入方式。" },
      { say: "查看已上架资产。", action: "打开资产目录。", expected: "看到资源状态查询 API。" },
      { say: "查看生命周期。", action: "打开发布与生命周期。", expected: "有版本和维护入口。" }
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
    transition: "先查看真实变更申请，再回查运行证据。",
    cue: "切换能力运营者角色并刷新。",
    fallback: "用只读审批页讲解状态机，不提交审批。"
  },
  {
    id: "operator-approval-demo",
    title: "能力运营者：变更审批",
    section: "能力运营者",
    role: "能力运营者",
    businessLabel: "审批队列",
    minutes: 2.6,
    purpose: "查看审批的输入、决策边界、生效、通知和审计状态",
    talk: [
      "审批队列中的变更申请是带业务编号、资源、申请人和意见的状态机。",
      "审批决定和意见都是审计输入；本次只读查看，不提交。",
      "结果会继续驱动生效、通知与版本动作。"
    ],
    transition: "审批决定变化能否进入线上，下一页看网关如何执行。",
    cue: "打开目标申请详情，指出审批字段，不做修改。",
    fallback: "目标申请已处理时，选择其他现有申请查看。",
    steps: [
      { say: "定位审批输入。", action: "打开审批队列。", expected: "看到资源、申请人和意见。" },
      { say: "查看状态机。", action: "展开申请详情。", expected: "有业务编号与完整审批表单。" },
      { say: "说明后续动作。", action: "关闭详情抽屉。", expected: "状态没有被改变。" }
    ]
  },
  {
    id: "operator-runtime-demo",
    title: "能力运营者：运行治理",
    section: "能力运营者",
    role: "能力运营者",
    businessLabel: "运行洞察",
    minutes: 3,
    purpose: "证明网关、Trace、节点、告警与集成状态可统一运营",
    talk: [
      "从最近调用中可以用 Trace ID 串起调用方、能力、路径、状态码和耗时。",
      "路由、配额、熔断、脱敏和安全规则由后端强制执行。",
      "节点与外部适配器均在同一运营面展示，本次不做生产变更。"
    ],
    transition: "运行治理解决线上行为，最后还需要管理员定义组织边界。",
    cue: "展示运行洞察、网关策略、网关节点和系统集成，不保存策略。",
    fallback: "Trace 查询失败时，保留错误卡并转到节点健康页。",
    steps: [
      { say: "查看调用证据。", action: "进入最近调用。", expected: "可见 200 和 Trace ID。" },
      { say: "查看网关策略。", action: "打开网关策略。", expected: "有 QPS、配额和脱敏规则。" },
      { say: "检查节点。", action: "打开网关节点。", expected: "双节点健康。" }
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
    cue: "切换系统管理员角色并刷新。",
    fallback: "用只读页面讲解，不修改用户状态。"
  },
  {
    id: "administrator-live-demo",
    title: "系统管理员：身份与流程",
    section: "系统管理员",
    role: "系统管理员",
    businessLabel: "权限与流程",
    minutes: 2.6,
    purpose: "证明角色菜单合同、细粒度权限和流程版本由后台管理",
    talk: [
      "用户绑定组织、角色与状态，也可以配置细粒度权限覆盖。",
      "角色模板、菜单配置、通知模板、密钥状态和审计都属于组织级控制项。",
      "已发布订阅流程有能力录入者和能力运营者两个节点。"
    ],
    transition: "五种角色都看完以后，用最后一张架构图解释稳定边界。",
    cue: "展示用户与组织、权限与流程、流程设计，不保存和发布。",
    fallback: "用离线画面说明用户、角色和已发布流程。",
    steps: [
      { say: "查看用户与组织。", action: "打开用户列表。", expected: "有组织、角色和权限覆盖。" },
      { say: "查看控制项。", action: "打开权限与流程。", expected: "密钥为脱敏状态。" },
      { say: "查看审批流程。", action: "打开流程设计。", expected: "显示两个已发布节点。" }
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

function createSteps(page: SeedPage): PresentationStep[] {
  if (page.steps) {
    return page.steps.flatMap((step, index) => [
      {
        id: `${page.id}-say-${index + 1}`,
        kind: "say" as const,
        text: step.say,
        execution: "hint" as const,
        conditionTimeoutSeconds: 8,
        risk: "normal" as const,
        autoContinue: false
      },
      ...(step.action
        ? [
            {
              id: `${page.id}-act-${index + 1}`,
              kind: "act" as const,
              text: step.action,
              action: step.action,
              expected: step.expected,
              execution: "hint" as const,
              conditionTimeoutSeconds: 8,
              risk: "normal" as const,
              autoContinue: false,
              presenterOnly: false
            }
          ]
        : [])
    ]);
  }

  return [
    { id: `${page.id}-say-1`, kind: "say", text: page.talk[0] ?? page.purpose, execution: "hint", conditionTimeoutSeconds: 8, risk: "normal", autoContinue: false, presenterOnly: false },
    { id: `${page.id}-transition`, kind: "transition", text: page.transition, execution: "hint", conditionTimeoutSeconds: 8, risk: "normal", autoContinue: false, presenterOnly: false }
  ];
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
  return {
    id: page.id,
    order,
    pageType: page.id === "closing" ? "end" : "business",
    enabled: true,
    title: page.title,
    section: page.section,
    tags: [page.role],
    purpose: page.purpose,
    transitionNote: page.transition,
    errorHandling: page.fallback,
    role: page.role,
    businessLabel: page.businessLabel,
    url: `http://localhost:3000/docs/demo/lc-apim-customer-demo/index.html?mode=presenter&showitPage=${page.id}`,
    connectorId: "lc-apim-local",
    variables: [],
    privacyMasks: [],
    estimatedSeconds: Math.round(page.minutes * 60),
    autoAdvanceSeconds: Math.round(page.minutes * 60),
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
  name: "LCAPIM 五角色治理闭环",
  description: "Showit 内置示例。来源于 LCAPIM 现有演示的可删除、可复制迁移版本。",
  status: "draft",
  totalPlannedSeconds: 1_800,
  autoAdvanceEnabled: false,
  autoAdvanceSeconds: 90,
  audienceJoinMode: "direct",
  audienceCapacityMode: "p2p-5",
  browserSessionMode: "daily",
  variables: [],
  sensitiveVariables: [],
  brand: {
    primaryColor: "#37d0ba",
    statusBackgroundColor: "#172533",
    privacyMessage: "演示准备中",
    loadingMessage: "正在加载 LCAPIM 业务画面",
    offlineLabel: "LCAPIM 离线备用",
    endTitle: "LCAPIM 演示结束",
    endDescription: "感谢观看五角色治理闭环演示",
    audienceTitle: "LCAPIM 演示观众屏"
  },
  layout: {
    stagePercent: 68,
    preset: "stage",
    noteFontScale: 1
  },
  connectors: [
    {
      id: "lc-apim-local",
      name: "LCAPIM 本机只读连接器",
      origin: "http://localhost:3000",
      mode: "extension",
      permission: "assist",
      securityMode: "readonly-proxy",
      environment: "本机黄金样例",
      requestHeaders: [],
      basicAuthInstructions: "如需登录，请在业务浏览器中完成本机账号登录。",
      loginPaths: ["/login", "/sso"],
      logoutPaths: ["/logout"],
      sandboxPermissions: ["allow-scripts", "allow-same-origin"],
      allowedOrigins: ["http://localhost:3000"]
    }
  ],
  pages: seedPages.map(createPage)
};

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
  laser: null,
  audienceStatus: "disconnected",
  audienceCount: 0,
  sequence: 0
};
