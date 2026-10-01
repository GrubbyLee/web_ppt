# AGENTS.md

面向编码智能体的工作区说明。改动代码前请先读完**约束**与**安全红线**两节。

## 项目是什么

Showit 是**本地优先的网页演示工作台**，以 Chrome 扩展（WXT / Manifest V3）交付。业务系统跑在**真实浏览器标签页**里，演讲者在**侧边栏控制台**中编排讲稿、步骤、计时、标注与画面投送。

版本 v0.3.0。源码主仓库是 Gitee（`https://gitee.com/287198991/showit.git`）；仓库里的 GitHub Actions 只服务 GitHub 镜像，推送到 Gitee **不会**触发，发布仍须按 [发布与回滚](docs/发布与回滚.md) 手工执行门禁。

## 仓库布局

```
packages/contracts/   Zod 数据合同 + 推断类型（唯一真相源，跨 app 共享）
apps/extension/       WXT + React 的 Chrome MV3 扩展（产品本体）
apps/relay/           观众中继：Node http + ws + SSE，无持久化、无账号
apps/demo-site/       Vite；产物输出到 apps/relay/public/demo（中继托管的演练控制台）
scripts/              Playwright 回归 + 打包/体积门禁/图标脚本
docs/                 需求/方案/计划/用户手册/发布回滚/法务
```

扩展的关键入口：`entrypoints/background.ts`（后台 service worker，**唯一持有运行时状态**）、`sidepanel/`（演讲者控制台）、`workbench/`（项目库 + 编辑器）、`stage/`、`audience/`、`offscreen/`（tabCapture → canvas 合成 → WebRTC）、`demo/`（内置演练控制台）、`business-tab.ts`（按需注入的连接器 + overlay）、`session/machine.ts`（纯函数状态机）、`lib/`（纯逻辑 + 同名单测）、`messaging/protocol.ts`（消息协议）。

## 常用命令

```bash
npm install
npm run dev                    # WXT 开发模式（chrome://extensions 加载 .output/chrome-mv3）
npm run typecheck              # 全 workspace（扩展侧含 wxt prepare）
npm run test                   # vitest：lib/ 与 session/ 的单元测试 + relay 测试
npm run build                  # 全量构建 + 体积门禁（扩展 ≤ 1200 KiB）
npm run build:demo-site        # 构建中继托管的演练控制台（改 lib/demo 后必须执行）

npm run test:extension-browser   # 冒烟：清单/侧边栏/工作台/内容脚本
npm run test:extension-e2e       # 端到端：真实 HTTP 业务页路径
npm run test:extension-demo-e2e  # 端到端：内置示例全产品验证（首选回归）
npm run test:remote-e2e          # 端到端：扩展 + 中继 + 观众浏览器
npm run release:extension        # 可复现 ZIP + SHA-256
```

浏览器回归需要 Chromium 与虚拟显示：`xvfb-run -a npm run test:extension-demo-e2e`（CI 同款）。

## 架构约束

- **后台 SW 是唯一状态源**：`machine`（会话状态机）+ `runtime`（标签/连接器/步骤执行等）都驻留在 background；所有界面通过长连接端口 `showit:<ctx>` 接收 `{ type: "state", state }` 广播。UI 不持有权威状态。
- **状态机必须是纯函数**：`session/machine.ts` 的 `applyAction(state, action, now)` 不做 IO。副作用（导航、注入、捕获、DNR）只能在 background 里做。
- **计时用时间戳模型**（`timerStartedAt` + 累计值），不要用 tick 累加：service worker 会被回收，`chrome.storage.session` 快照要能原样恢复。
- **MV3 的硬限制**：`chrome-extension://` 页不能被 `executeScript` 注入，也**不能被 tabCapture 捕获**。因此内置演练控制台自己实现同一套连接器协议（`demo/main.tsx`），DOM 逻辑与注入脚本共用 `lib/dom-connector.ts`；远程观众要看内置示例时，会话标签会切到**中继托管的 HTTP 副本**（`apps/demo-site` 的产物）。
  - 该副本是普通 http 页，被分类为 `business`（`startCapture` 只捕获 business 标签，这是它能被远程看到的**前提**，不要改成 `demo`）。
  - 代价是 `businessReady()` 里 `demo://` 的判定（要求 `tabKind === "demo"`）对它永远为假，所以有 `isRelayHostedDemoUrl()` 分支：按注入连接器的状态判定就绪，登录关卡照旧阻断、登录后自动恢复。
- **演示画面标签开在演示者窗口内**（即侧边栏所在窗口），不要新建独立窗口：独立窗口会让演讲者每次点击控制台都把演示页推到后台并失焦。仅"专用演示环境（无痕）"才开独立窗口。

## 编码约定

- TypeScript 严格模式，且开了 `exactOptionalPropertyTypes` 与 `noUncheckedIndexedAccess`：可选字段要用条件展开（`...(x ? { x } : {})`），不要写 `x: undefined`；索引访问要处理 `undefined`。
- 注释写**为什么**，用中文；标识符用英文。代码里的"为什么"注释是本仓库的重要资产，修改行为时同步更新它们。
- 改数据结构时，`packages/contracts` 的 Zod schema 是唯一真相源：schema + 推断类型 + 单测一起改，并确认导入旧 `.showit` 包仍可解析（格式兼容是硬要求）。
- 纯逻辑放 `lib/` 并配同名 `*.test.ts`（vitest / jsdom）；新行为要补断言，端到端行为补到 `scripts/playwright-*.mjs`。
- 用户可见文案（含诊断、报错、手册）用中文。

## 安全红线

这些不是建议，是产品承诺（见 `docs/用户手册.md` §8）：

1. **凭据永不落地**：不保存业务账号、密码、Cookie、Token、Secret。`SensitiveRuntimeVariable` 契约**故意没有 `value` 字段**，敏感值只存在于进程内存（`lib/runtime-secrets.ts`，带过期时间）。
2. **URL 白名单**：只允许 HTTPS / 本机 HTTP / `demo://`；拒绝内嵌凭据与敏感查询参数。变量名、定位器、连接器 Header 都要过敏感名检查，Header 不得覆盖代理控制字段。
3. **观众侧零信任**：观众只接收**捕获并合成后**的像素流，不打开业务 URL、不读 DOM/Cookie/登录态；观众侧 HTML 禁脚本与外部网络。隐私遮罩/封面在合成器层**二次强制**，不能只靠 UI。
4. **写操作拦截**用 DNR（`lib/request-protection.ts`）：拦截除 GET/HEAD/OPTIONS 外的所有方法，只放行登录/退出/角色切换路径；路径校验拒绝 `%`（防双重编码穿越）。会话结束/启动无快照时必须清理动态规则。
5. **脱敏后再落盘**：诊断、导出包都要过 `redact`/`redactSensitiveText`（含 URL 替换）。
6. **ZIP 必须先验元数据再解压**（`lib/zip-safety.ts`），导入路径要做穿越与体积校验，加密包用 Argon2id 且对 KDF 参数设上限。

## 交付

- 发布：`npm run release:extension` → `apps/extension/release/Showit_Extension_<v>.zip` + `.sha256`；要求**两次构建产物字节一致**（CI 会校验）。
- 改 `lib/demo/` 后必须 `npm run build:demo-site`，否则中继的 `/demo/` 会 404（`apps/relay/public/demo/` 未被 git 跟踪）。
- 用户可见行为变化要同步 `docs/用户手册.md`；架构变化补 `docs/` 下的版本方案文档。

## 已知易错点

- Playwright 回归用 `test-results/*-profile` 持久化 profile（扩展只能在持久化上下文里加载）。**陈旧 profile 会造成假失败**（侧边栏页码不对、`Unable to capture screenshot`），所以脚本每次运行前会自动清空它（`scripts/e2e-profile.mjs`）；排查失败现场时设 `SHOWIT_E2E_KEEP_PROFILE=1` 可保留 profile。
- `test:remote-e2e` 占用 8899 端口；若上一轮遗留了 relay 进程会 `EADDRINUSE`，先 `pkill -f "relay/src/main.ts"`。
- `npm run dev` 之外改了入口/清单后，跑 `npm run typecheck` 会先执行 `wxt prepare` 重新生成 `.wxt/types`。
- 旧版 LCAPIM 示例（指向 localhost:3001）在未被修改时会自动升级为内置示例，测试时不要假设它还在。

## 参考文档

- [用户手册](docs/用户手册.md) —— 行为与边界的权威描述
- [发布与回滚](docs/发布与回滚.md) —— 发布门禁
- [开发前的指导](docs/开发前的指导.md) —— 设计原则与验收口径
- [v0.2.0 架构重写方案](docs/v0.2.0-架构重写方案.md) · [v0.2.1 内置演示系统](docs/v0.2.1-内置演示系统方案.md) · [v0.3.0 远程观众](docs/v0.3.0-远程观众方案.md)
