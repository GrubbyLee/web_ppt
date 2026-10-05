# Showit

**面向主讲人的 Web 业务演示平台。**

Showit 通过 Chrome 扩展把真实 Web 业务系统、演示讲稿、操作步骤、计时、标注、隐私保护和观众画面整合到一个现场控制台中。业务系统始终运行在真实浏览器标签页里，观众只接收源端捕获并合成后的只读画面。

> **Project status:** Showit is an active prototype / internal pilot. It is suitable for controlled demos and technical evaluation; signed installers, TURN-based public delivery, and cross-platform acceptance are not complete yet.

## 核心能力 | Highlights

- **真实业务页**：业务系统运行在真实 Chrome 标签页，不复制业务实例、不依赖 iframe。
- **主讲控制台**：在侧边栏管理页面、讲稿、步骤、计时、自动翻页和排练。
- **现场工具**：激光笔、圈选、撤销、整屏遮罩、黑屏、白屏、冻结和离线备用。
- **隐私与安全**：敏感变量不落盘；密码、MFA、文件选择期间自动保护观众画面；默认拦截业务写操作。
- **两种观众出口**：视频会议共享只读窗口，或通过 Relay 链接让观众浏览器观看。
- **独立业务 Demo**：`demo/` 提供完全独立的 Northstar Supply HTTP 示例系统。
- **本机 Relay Companion**：自动启动中继、处理端口冲突，并由扩展自动发现实际地址。

## English

**A presenter-focused platform for live web business demonstrations.**

Showit is a Chrome extension that combines real web applications, presentation scripts, guided steps, timers, annotations, privacy protection, and audience delivery in one presenter console. The business application stays in a real browser tab; audiences receive only the source-side composited, read-only pixels.

Highlights:

- Real browser tabs instead of duplicated or embedded business instances.
- Presenter-side scripts, steps, timers, rehearsal, annotations, and screen controls.
- Runtime-only secrets, automatic privacy covers, and default write-operation protection.
- Video-meeting sharing through a clean audience window, or read-only remote viewing through Relay.
- An independent HTTP business demo in `demo/`.
- A local Relay Companion with automatic port discovery.

## 快速体验 | Quick Start

### 环境要求 | Requirements

- Node.js `22.x`
- npm `10.x` or newer
- Google Chrome or a Chromium-based browser
- Linux browser tests additionally require Chromium and `xvfb`

### 启动本机演示环境 | Start the local demo environment

```bash
npm ci
npm run start:local
```

这会同时启动：

```text
Showit 扩展开发服务   http://localhost:6666
独立 Northstar Demo  http://127.0.0.1:7777
Relay Companion       http://127.0.0.1:9999
Relay                 http://127.0.0.1:8888（端口冲突时自动回退）
```

The command starts the extension dev server, the independent business demo, the local Relay Companion, and the audience Relay. The Companion handles Relay port conflicts and exposes the actual Relay address to the extension.

### 加载扩展 | Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select:

```text
apps/extension/.output/chrome-mv3-dev
```

5. Open the Showit side panel from the Chrome toolbar.

### 体验远程观众 | Try remote audience viewing

1. Run an internal or imported project.
2. Open **远程观众 / Remote audience**.
3. Click **连接本机中继 / Connect local Relay**.
4. Check the connection, then start remote audience delivery.
5. Copy the generated viewer URL.
6. Open it in an incognito window or another browser profile.

The viewer should receive a read-only audience stream. During login or sensitive input, the audience sees a privacy cover instead of the business page.

### 使用独立业务 Demo | Use the independent business demo

The imported project template is:

```text
demo/Northstar_Supply_Demo.showit
```

It targets `http://127.0.0.1:7777` and demonstrates login, sensitive variables, a business overview, inventory, and order pages. This demo is independent from Showit's built-in **云枢 · 五角色能力治理闭环** sample.

## 常用命令 | Commands

```bash
npm run typecheck
npm test
npm run build
npm run start:local
npm run package:companion

# Browser regression
xvfb-run -a npm run test:extension-browser
xvfb-run -a npm run test:extension-demo-e2e
xvfb-run -a npm run test:remote-e2e

# Reproducible extension package
npm run release:extension
```

## 项目结构 | Repository layout

```text
demo/                 独立 Northstar Supply 业务 Demo
apps/extension/       Chrome MV3 扩展，产品本体
apps/relay/           Node HTTP/WebSocket/SSE 观众中继
apps/demo-site/       内置云枢示例的中继托管副本
packages/contracts/   Zod 数据合同，跨模块唯一真相源
scripts/              构建、打包和 Playwright 回归脚本
docs/                 当前实现、用户手册、发布和法务文档
```

> Note: `apps/extension/` is expanded separately below to keep the layout readable.
```text
apps/extension/
├─ entrypoints/background.ts       状态源、编排、捕获与中继分发
├─ entrypoints/sidepanel/          主讲侧边栏控制台
├─ entrypoints/workbench/          项目库与编辑器
├─ entrypoints/audience/           本机观众窗口
├─ entrypoints/offscreen/          捕获、合成与 WebRTC
├─ entrypoints/business-tab.ts     业务页连接器与 overlay
├─ session/machine.ts               纯函数会话状态机
└─ lib/                             纯逻辑与测试
```

## 安全边界 | Security boundary

- Credentials, cookies, tokens, and secrets are never stored in project packages.
- Sensitive runtime values exist only in memory during the active presentation.
- The audience never opens the business URL or reads business DOM, cookies, or login state.
- Relay forwards room state, signaling, and already-composited pixels; it does not inspect business pages.
- Imported projects are checked for origins, offline resources, automation, high-risk steps, and content integrity.

详见 [当前实现说明](docs/当前实现说明.md) 和 [用户手册](docs/用户手册.md)。

## 文档 | Documentation

- [当前实现说明 | Current implementation](docs/当前实现说明.md)
- [用户手册 | Presenter guide](docs/用户手册.md)
- [发布与回滚 | Release and rollback](docs/发布与回滚.md)
- [法务文件 | Legal](docs/legal/)

## 当前边界 | Current limits

- Remote delivery currently uses P2P WebRTC; public connectivity depends on the network environment.
- TURN, SFU, signed native installers, automatic updates, and cross-platform installation acceptance are not complete.
- The project is currently intended for internal pilots, controlled demos, and technical evaluation.

## License

Showit is distributed under a commercial license. See [`docs/legal/COMMERCIAL-LICENSE.zh-CN.txt`](docs/legal/COMMERCIAL-LICENSE.zh-CN.txt), [`docs/legal/EULA.zh-CN.txt`](docs/legal/EULA.zh-CN.txt), and the third-party notices.

源码仓库：`https://gitee.com/synovation/showit`
