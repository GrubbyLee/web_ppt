# Showit

Showit 是本地优先的网页演示客户端。当前代码包含 Tauri 2 + React 19 + Vite 8 桌面端、本地项目编辑器、演讲者四区控制台、局域网观众服务、共享合同和 Manifest V3 扩展。

## 开发命令

```bash
npm install
npm run dev
npm run typecheck
npm run test
npm run build
npm run tauri:dev
```

默认 Web 开发地址是 `http://localhost:4173/#/projects`。演讲运行时可直接访问 `http://localhost:4173/#/presenter`。本机 `5173` 已被其他服务占用，因此 Showit 固定使用 `4173`。

## 当前范围

- `packages/contracts`：项目、页面、步骤、连接器、版本、排练、会话和观众事件 Zod/TypeScript 合同。
- `apps/desktop`：项目库、页面/脚本/连接器编辑器、演讲者运行时、SQLite 版本与排练记录、本机观众窗口和带令牌的局域网观众服务。
- 离线备用支持内嵌截图、MP4/WebM 和网络隔离 HTML；切换状态会同步到本机与局域网观众屏。观众侧 HTML 禁止脚本和外部网络。
- `.showit` 使用 ZIP 文件布局，分离清单、页面、Markdown、品牌资源和离线资源；密码包采用 Argon2id + AES-256-GCM，并兼容导入旧版 JSON 项目包。
- 第三方项目导入前显示域名、离线 HTML、自动权限、高风险步骤和资源大小，信任记录绑定项目 SHA-256 内容指纹。
- 高风险步骤必须在演讲者控制台显式确认后才能完成。
- 条件验证失败后可填写原因强制完成；原因随会话保存。普通步骤可配置验证成功后自动进入同页的下一个普通步骤。
- 演讲者可框选实色或模糊隐私遮罩；遮罩保存到页面，并同步覆盖本机与局域网观众输出。局域网分享可选择 IPv4 网络接口，显示实时在线人数、质量和容量，并支持断开单个或全部观众。
- 项目可选择 5 人 P2P 或 20 人本地 LiveKit SFU。SFU 只在启动分享期间运行，扩展只发布一路标签画面，观众使用离线打包的 LiveKit 客户端订阅；仅绑定所选 LAN 接口，不配置公网 STUN/TURN。缺少已校验的 sidecar 时会拒绝启动 SFU 模式。
- 底部显示总计时、本页计时、本章计时和本页剩余时间。自动翻页使用独立时钟，设置、Markdown 编辑、业务页加载/异常、连接器异常、屏幕控制、标注、遮罩选择和步骤确认期间会停表。
- 本机观众窗口优先全屏显示在演讲者窗口之外的显示器；它与局域网观众一样只接收本机 WebRTC 像素流。目标显示器拔出后自动关闭，状态同步回控制台，且不会自动重开。
- 安装包包含闭源商业许可声明和简体中文 EULA；便携版可通过可执行文件旁的 `portable-data.enabled` 标记启用同目录 `data` 数据目录。
- `apps/extension`：Manifest V3 Side Panel、按 Origin 动态授权、业务页状态探测、Native Messaging 控制与 `tabCapture` WebRTC 发布端。
- `scripts/playwright-smoke.mjs`：演讲者、同机观众屏、计时、标注与响应式冒烟回归。
- `scripts/playwright-project-workspace.mjs`：项目创建、URL 安全校验、自动保存、发布版本、排练和运行时加载回归。

LCAPIM 内置样例包含 18 页顺序和脚本摘要，作为可删除、可复制的首个本地项目。

## 验证命令

```bash
npm run typecheck
npm run test
npm run build
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run test:sfu
python3 /home/arabica/.codex/skills/webapp-testing/scripts/with_server.py \
  --server "npm run dev -w @showit/desktop" \
  --port 4173 \
  --timeout 60 \
  -- node scripts/playwright-smoke.mjs
```

Linux `.deb` 可单独构建：

```bash
npm run tauri:build -w @showit/desktop -- --bundles deb
```

构建脚本会先生成 `showit-native-host` 并下载 SHA-256 校验的 LiveKit `v1.13.6` sidecar，再交给 Tauri 一并打包。LiveKit 的第三方归属和 Apache-2.0 完整文本会随安装包置于 `legal/`。

Windows 主程序和 Native Host 完成构建后，可生成便携 ZIP 和对应 SHA-256：

```bash
npm run release:portable-windows
```

`.github/workflows/build.yml` 在 Ubuntu 24.04 和 Windows Server 2022 上执行质量门禁并生成 Linux `.deb`、AppImage、Windows 当前用户 NSIS、便携 ZIP、独立扩展 ZIP 及各自 SHA-256 工件。标签发布还会生成经 Tauri 签名校验的更新工件和 `latest.json`。

发布仓库需要配置以下 CI 值：`TAURI_SIGNING_PRIVATE_KEY` 与可选 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（Actions Secrets）、`SHOWIT_UPDATER_PUBKEY` 与 `SHOWIT_EXTENSION_IDS`（Actions Variables，后者为逗号分隔的 Chrome/Edge 商店或企业扩展 ID）。这些值缺失时标签构建会停止，避免发布无法验证更新或无法连接 Native Messaging Host 的安装包。

拿到商店扩展 ID 后，可注册当前用户的 Native Messaging Host：

```bash
npm run native-host:register -- --extension-id <32 位扩展 ID> --host <showit-native-host 绝对路径>
```

扩展 Native Host 与局域网投送的开发安装步骤见 [扩展与 Native Messaging 架构](docs/architecture/extension-native-messaging.md)。Chrome、Edge、Chromium 的真实扩展加载和跨设备 WebRTC 仍需在对应平台手工验收。

使用与交付文档：

- [用户手册](docs/用户手册.md)
- [发布与回滚](docs/发布与回滚.md)
- [v0.1.0 发布候选验收记录](docs/v0.1.0-发布候选验收记录.md)

源码主仓库为 `https://gitee.com/287198991/showit.git`。仓库中的 GitHub Actions 工作流用于 GitHub 镜像或兼容 Runner；仅推送到 Gitee 不会自动执行该工作流，发布前仍须按发布文档执行门禁并配置签名与更新端点。
