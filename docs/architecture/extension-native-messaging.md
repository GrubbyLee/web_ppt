# 浏览器扩展与 Native Messaging

`apps/extension` 是 Manifest V3 构建包。它只声明 optional host permissions，不包含静态全站 `content_scripts`。用户在 Side Panel 点击授权后，后台按单个 Origin 注册持久化动态脚本；不同 Origin 使用不同注册 ID，互不覆盖。

## 开发加载

1. 运行 `npm run build -w @showit/extension`。
2. 在 Chrome、Edge 或 Chromium 的扩展管理页启用开发者模式。
3. 选择“加载已解压的扩展程序”，目录为 `apps/extension/dist`。
4. 首次连接业务站点时，由 Side Panel 按 Origin 请求 host permission。
5. 在桌面端设置中启动局域网观众分享，再在 Side Panel 点击“投送当前标签”。

## Native Host

`apps/extension/native-host/com.showit.desktop.json` 是安装器替换后的 manifest 模板：

- `__SHOWIT_NATIVE_HOST_PATH__` 替换为当前平台上的 desktop host 可执行文件绝对路径。
- `__SHOWIT_EXTENSION_ID__` 替换为正式商店或企业策略部署的扩展 ID。
- Host 只接受最大 1 MiB 的长度前缀 JSON 消息。
- Host 从当前用户运行时目录读取桌面端生成的随机端口和 48 字符令牌，令牌文件在 Unix 上使用 `0600` 权限。
- 桌面桥接只监听 `127.0.0.1`，拒绝令牌错误、无 `type` 或超长消息。

开发期构建 Host：

```bash
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --bin showit-native-host
```

生成的开发二进制位于 `apps/desktop/src-tauri/target/debug/showit-native-host`。构建发布版 Host 后，可通过用户级注册脚本生成 manifest 并同时注册 Chrome、Edge 和 Chromium：

```bash
npm run native-host:register -- \
  --extension-id abcdefghijklmnopabcdefghijklmnop \
  --host "$PWD/apps/desktop/src-tauri/target/release/showit-native-host"
```

Windows 使用同一命令写入 `HKCU`，不要求管理员权限。卸载时追加 `--uninstall`。正式打包流水线通过 `SHOWIT_EXTENSION_IDS` 注入一个或多个逗号分隔的商店签名扩展 ID；标签构建会生成 NSIS 钩子，在安装时写入 Host manifest 与 Chrome、Edge、Chromium 的当前用户注册表项，并在卸载时清理。脚本会拒绝占位符和格式错误的 ID。

## 控制与媒体链路

```text
PresenterShell
  -> Tauri NativeBridge -> showit-native-host -> MV3 service worker -> Side Panel
  <- 上一页 / 下一页 / 聚焦 Showit

业务标签 -> chrome.tabCapture -> Side Panel RTCPeerConnection
  -> 本机 WebSocket 信令 -> 最多 5 个局域网观众 RTCPeerConnection
```

局域网服务绑定随机端口，并为观众链接和 WebRTC 发布端分别生成不可互换的 32 字符令牌。观众页面先通过 WebSocket 登记随机观众 ID；等待批准模式下，演讲者批准后才占用容量并加入信令。SSE 路径绑定已连接的观众 ID，审批前返回 `403`，拒绝或单个断开后服务端主动终止数据流。桌面设置显示名称、来源 IP、申请时间和连接状态，可批准、拒绝或断开单个观众。

明确返回项目库或退出演示时，桌面端先向本机 BroadcastChannel 和局域网 SSE 发布 `screenMode=ended`，再发送 `bye/session-ended` 并停止服务。观众、发布和本机令牌随房间删除立即失效；同一会话重新分享也生成全新令牌。退出清理同时撤销扩展动态请求保护规则、停止 Side Panel 投送、关闭只读代理并删除运行恢复槽；异常退出只释放进程内密钥和活动服务，保留 SQLite 恢复快照。

获准观众通过 SSE 接收页码、屏幕模式和恢复快照，通过 WebSocket 交换 WebRTC `offer/answer/ice`；`RTCPeerConnection` 使用空 `iceServers`，不依赖公网 STUN/TURN。媒体只有视频轨道，不采集或发送音频。

业务页状态桥只接收 `showit:connector-state`，并把状态限制为 `ready、anonymous、role-mismatch、loading、error、blocked`；只透传最多 80 字符的角色名，不读取 Cookie、Token、密码或任意页面消息。

录制器只保存稳定定位器和动作元数据。普通输入/选择可记录为 `fill`，但录制期间永不采集输入值；密码、文件、MFA/SSO 和敏感字段不生成填写动作。运行时由桌面端把固定值、项目变量、页面变量或进程内敏感变量解析成一次性执行消息。扩展不会持久化解析后的值，不在诊断或执行结果中回显；辅助模式只聚焦/高亮，自动模式才使用原生 setter 并发送 `input`、`change` 事件。

请求保护模式由 MV3 动态规则在浏览器层拒绝写方法，只允许经过规范化的显式登录/退出路径。桌面的本机只读代理是独立防线：仅绑定 `127.0.0.1`、固定上游 Origin、允许 `GET/HEAD/OPTIONS`、在访问上游前返回 `403 SHOWIT_PRESENTATION_READ_ONLY`，并改写请求 Origin/Referer、响应重定向、CORS/CSP 等响应 Header、Cookie Domain 与文本中的绝对 Origin。代理只转发通过校验的非敏感静态 Header，不接受 Authorization、Cookie、Token、Secret、Credential、API Key 或代理控制类 Header；启动失败时运行时不直接访问目标站点。

新标签接管在首帧投送前检查密码、文件、MFA 和 SSO 页面。敏感或登录标签维持整页隐私状态，直到演讲者恢复。资源失败只向桌面端报告聚合数量，不传资源 URL，避免查询参数或资源标识进入诊断。

桌面、扩展和 Rust 持久化层分别执行诊断脱敏。完整 HTTP(S) 业务 URL、JSON/文本形式的 Token/Secret/密码、Cookie Header、Basic/Bearer 凭据在落盘前替换，避免只清理查询参数而保留路径中的业务对象标识。

尚未完成的外部验收项包括：配置真实商店签名扩展 ID、Chrome/Edge/Chromium 真机矩阵、网络降级码率与跨设备 1080p 性能验收。
