# Showit

Showit 是本地优先的网页演示工作台，以 **Chrome 扩展**（WXT / Manifest V3）形式交付：业务页面在真实浏览器标签页中运行，演讲者在浏览器**侧边栏控制台**中编排讲稿、步骤、计时、标注与画面投送。

v0.2.0 完成了从 Tauri 桌面端到纯浏览器扩展的架构重写（见 [v0.2.0 架构重写方案](docs/v0.2.0-架构重写方案.md)）。v0.1 项目包（`.showit`）可直接导入。

## 安装

- 日常开发：`npm run dev -w @showit/extension`，按 WXT 提示在 Chrome 加载 `.output/chrome-mv3`。
- 生产安装：下载 release 的 `Showit_Extension_<version>.zip`，解压后在 `chrome://extensions` 打开开发者模式并“加载已解压的扩展程序”。
- 首次运行某个项目时，Chrome 会请求业务系统站点访问权限（按 Origin 逐个授权）。
- 观众画面捕获需要授权：在演示画面标签上右键选择“Showit：授权画面捕获”，或按 `Ctrl+Shift+9`（工具栏图标用于打开控制台）。

## 开发命令

```bash
npm install
npm run dev            # WXT 开发模式
npm run typecheck
npm run test           # vitest 单元测试
npm run build          # wxt build + 体积门禁
npm run test:extension-browser   # 组件级冒烟（清单/侧边栏/工作台/内容脚本）
npm run test:extension-e2e       # 端到端（真实 HTTP 业务页路径）
npm run test:extension-demo-e2e  # 端到端（内置示例全产品验证）
npm run release:extension        # 可复现 ZIP + SHA-256
```

## 架构总览

```
apps/extension（WXT, Chrome MV3）
├─ entrypoints/background.ts    # SW：会话状态机、编排、DNR、捕获与观众分发
├─ entrypoints/sidepanel/       # 演讲者控制台（四区垂直布局）
├─ entrypoints/workbench/       # 项目库 + 项目编辑器（普通标签页）
├─ entrypoints/stage/           # 固定页/离线备用的演示画面
├─ entrypoints/audience/        # 观众屏渲染（本机：共享源/预览；远程：中继观看页）
├─ entrypoints/offscreen/       # tabCapture → canvas 合成 → 分发
├─ entrypoints/business-tab.ts  # 按需注入的业务页连接器 + overlay
├─ session/machine.ts           # 纯函数会话状态机（30+ 动作）
├─ lib/                         # 从 v0.1 移植的纯逻辑库（含测试）
└─ messaging/protocol.ts        # 扩展内部消息协议
packages/contracts              # 项目/页面/步骤/连接器/版本/排练 Zod 合同（与 v0.1 兼容）
```

## 当前范围

- 项目库、页面/脚本/步骤/连接器编辑器、发布版本、排练历史存于 IndexedDB（大离线资产随项目结构化存储）；信任记录、诊断存 `chrome.storage.local`。
- 会话状态机在 background service worker 中运行，快照写入 `chrome.storage.session`，SW 重启后自动恢复（计时用时间戳模型，不丢秒数）。
- 业务页面 = 会话托管标签页：iframe/window/extension 三种连接器模式统一映射为标签页策略（当前窗口 / 独立窗口 / 无痕窗口）。
- 高风险步骤确认、条件验证失败强制完成（必填原因）、敏感变量（`storage.session`，浏览器关闭即清）、录制操作（不含输入值）。
- 激光笔/圈选标注/隐私遮罩/屏幕封面/离线备用渲染为业务标签页内的 overlay；观众画面经 offscreen 合成器二次强制（遮罩永不泄露）。
- `request-protection` 与 `readonly-proxy` 由 DNR 规则实现（拦截写方法请求，登录/登出/切角路径可放行）。
- 本机 = 演示者（业务页面 + 侧边栏控制台）。观众只有两种形态：远程观众（独立中继 `apps/relay`，观众浏览器打开链接，P2P ≤5 建议）；视频会议共享（共享本机“观众屏”窗口或业务页面窗口）。
- 第三方项目导入前显示域名、离线 HTML、自动权限、高风险步骤与资源大小，信任记录绑定项目 SHA-256 内容指纹。
- 内置「云枢 · 五角色能力治理闭环」18 页示例：业务系统为扩展内置的演示控制台（`demo://` 视图），完全离线运行；登录步骤演示敏感变量、发布步骤演示高风险确认、搜索链演示验证后自动续跑，并覆盖标注、遮罩、观众镜像与离线备用。
- 敏感数据红线：不保存业务账号、密码、Cookie、Token 或 Secret；观众侧 HTML 禁止脚本和外部网络。

## 范围裁剪（相对 v0.1）

纯扩展无法监听 TCP 端口，以下能力已移除并写入用户手册：局域网观众 HTTP/SSE/WS 服务、LiveKit SFU（20 人）、观众审批/踢出/质量统计、网络接口选择、应用内更新器。合成器 + WebRTC 管线保留，为未来“导出观看页 + 手动连接码”预留。

## 使用与交付文档

- [用户手册](docs/用户手册.md)
- [v0.2.0 架构重写方案](docs/v0.2.0-架构重写方案.md)
- [发布与回滚](docs/发布与回滚.md)

源码主仓库为 `https://gitee.com/287198991/showit.git`。仓库中的 GitHub Actions 工作流用于 GitHub 镜像或兼容 Runner；仅推送到 Gitee 不会自动执行该工作流，发布前仍须按发布文档执行门禁。
