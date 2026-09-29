import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const extensionDir = resolve(root, "apps/extension/.output/chrome-mv3");
const resultsDir = resolve(root, "test-results");
const fixturePort = 8907;

const fixtureHtml = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>业务演示页</title></head>
<body>
  <main>
    <h1 id="customer-name">客户名称占位</h1>
    <label>普通输入 <input id="assist-name" data-testid="assist-name" autocomplete="off"></label>
    <label>登录密码 <input id="login-password" type="password" autocomplete="current-password"></label>
    <button type="button" data-testid="confirm-order" aria-label="确认订单">确认订单</button>
  </main>
  <script>
    window.__events = [];
    for (const id of ["assist-name"]) {
      const input = document.getElementById(id);
      input.addEventListener("input", () => window.__events.push(["input", input.value]));
      input.addEventListener("change", () => window.__events.push(["change", input.value]));
    }
  </script>
</body>
</html>`;

const assert = (condition, message) => {
  if (!condition) throw new Error(`断言失败：${message}`);
  console.log(`  ✓ ${message}`);
};

const server = createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(fixtureHtml);
});

await new Promise((resolvePromise) => server.listen(fixturePort, "127.0.0.1", resolvePromise));

const context = await chromium.launchPersistentContext(resolve(resultsDir, "extension-smoke-profile"), {
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check"
  ]
});

try {
  console.log("1) 清单与后台");
  let serviceWorker = context.serviceWorkers().at(0);
  serviceWorker ??= await context.waitForEvent("serviceworker", { timeout: 10_000 });
  const extensionId = serviceWorker.url().split("/").at(2);
  assert(/^[a-p]{32}$/.test(extensionId ?? ""), `扩展 ID 有效（${extensionId}）`);

  const manifest = await serviceWorker.evaluate(async () => {
    const response = await fetch(chrome.runtime.getURL("manifest.json"));
    return response.json();
  });
  assert(manifest.manifest_version === 3, "manifest 是 MV3");
  assert(manifest.background?.service_worker === "background.js", "后台 service worker 指向 background.js");
  assert(manifest.side_panel?.default_path === "sidepanel.html", "侧边栏指向 sidepanel.html");
  assert(!("content_scripts" in manifest), "清单没有静态 content_scripts（全部按需注入）");
  assert(manifest.permissions.includes("tabCapture") && manifest.permissions.includes("offscreen"), "包含 tabCapture 与 offscreen 权限");
  assert(JSON.stringify(manifest.optional_host_permissions) === JSON.stringify(["http://*/*", "https://*/*"]), "可选主机权限按 Origin 运行时申请");
  const registered = await serviceWorker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  assert(Array.isArray(registered) && registered.length === 0, "没有持久注册的内容脚本");

  console.log("2) 侧边栏控制台");
  const sidepanel = await context.newPage();
  await sidepanel.setViewportSize({ width: 400, height: 800 });
  await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await sidepanel.waitForSelector(".panel-brand", { timeout: 5_000 });
  assert((await sidepanel.textContent(".panel-brand strong")) === "Showit", "侧边栏标题为 Showit");
  await sidepanel.waitForSelector("text=打开工作台", { timeout: 5_000 });
  assert(await sidepanel.isVisible("text=当前没有正在运行的演示。"), "无会话时显示落地状态");
  const overflow = await sidepanel.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 0, "侧边栏无水平溢出");
  await sidepanel.screenshot({ path: resolve(resultsDir, "extension-sidepanel.png") });

  console.log("3) 工作台");
  const workbench = await context.newPage();
  await workbench.goto(`chrome-extension://${extensionId}/workbench.html`);
  await workbench.waitForSelector(".workspace-topbar", { timeout: 5_000 });
  await workbench.waitForSelector("text=个本地项目", { timeout: 10_000 });
  assert(await workbench.isVisible("text=云枢 · 五角色能力治理闭环"), "内置云松示例项目已初始化");
  const workbenchOverflow = await workbench.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(workbenchOverflow <= 0, "工作台无水平溢出");
  await workbench.screenshot({ path: resolve(resultsDir, "extension-workbench.png") });

  console.log("4) 业务页连接器（内容脚本）");
  const business = await context.newPage();
  await business.addInitScript(() => {
    const sent = [];
    window.__showitSent = sent;
    window.__showitListeners = [];
    window.chrome = window.chrome ?? {};
    window.chrome.runtime = {
      id: "smoketestextensionid0000000000000",
      sendMessage: (message) => { sent.push(message); return Promise.resolve({ accepted: true }); },
      onMessage: {
        addListener: (listener) => window.__showitListeners.push(listener)
      }
    };
    window.__sendShowitMessage = (message) => {
      let response = null;
      for (const listener of window.__showitListeners) listener(message, {}, (value) => { response = value; });
      return response;
    };
  });
  await business.goto(`http://127.0.0.1:${fixturePort}/?token=must-not-leak`);
  const contentScript = await readFile(resolve(extensionDir, "business-tab.js"), "utf8");
  await business.addScriptTag({ content: contentScript });

  const probe = await business.evaluate(() => window.__sendShowitMessage({ type: "showit-probe" }));
  assert(probe?.privacyRisk === "password" && probe?.hasPasswordField === true, "探测返回密码字段风险");
  assert(typeof probe?.origin === "string" && probe.origin.startsWith("http://127.0.0.1"), "探测返回页面 Origin");

  const recorderStart = await business.evaluate(() => window.__sendShowitMessage({ type: "showit-recorder-start", recordingId: "rec-1" }));
  assert(recorderStart?.ok === true, "录制器启动");
  assert(!recorderStart.url.includes("token="), "录制上报的 URL 不含查询串");

  await business.fill("#assist-name", "普通值");
  await business.fill("#login-password", "super-secret-value");
  await business.click("[data-testid=confirm-order]");
  await business.evaluate(() => window.dispatchEvent(new Event("scroll")));
  await business.waitForTimeout(400);
  const recorded = await business.evaluate(() => window.__showitSent.filter((message) => message.type === "showit-recorded-action"));
  assert(recorded.length >= 2, `录制到 ${recorded.length} 个动作`);
  const serialized = JSON.stringify(recorded);
  assert(!serialized.includes("super-secret-value") && !serialized.includes("普通值"), "录制消息不含输入值");
  assert(!serialized.includes("login-password") && !serialized.includes("password"), "录制消息不含敏感字段名");
  const stopResult = await business.evaluate(() => window.__sendShowitMessage({ type: "showit-recorder-stop" }));
  assert(stopResult?.ok === true, "录制器停止");

  const autoFill = await business.evaluate(() => window.__sendShowitMessage({ type: "showit-execute-action", action: { type: "fill", locator: { strategy: "testid", value: "assist-name" }, value: "自动填写" }, execution: "auto" }));
  assert(autoFill?.ok === true && autoFill?.performed === "fill", "auto 模式写入值");
  const events = await business.evaluate(() => window.__events);
  assert(events.some((item) => item[0] === "input" && item[1] === "自动填写") && events.some((item) => item[0] === "change"), "写入触发 input 与 change 事件");

  const assistFill = await business.evaluate(() => window.__sendShowitMessage({ type: "showit-execute-action", action: { type: "fill", locator: { strategy: "testid", value: "assist-name" }, value: "协助填写" }, execution: "assist" }));
  assert(assistFill?.ok === true && assistFill?.performed === "focus", "assist 模式只聚焦不写入");

  const overlay = await business.evaluate(() => window.__sendShowitMessage({
    type: "showit-overlay",
    overlay: {
      sessionId: "session-smoke",
      pageId: "page-1",
      screenMode: "normal",
      annotationTool: "none",
      circles: [{ id: "circle-1", x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.4 }],
      privacyMasks: [{ id: "mask-1", x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3, mode: "blur" }],
      offlineActive: false,
      brand: { primaryColor: "#37d0ba", privacyMessage: "画面已保护" }
    }
  }));
  assert(overlay?.ok === true, "遮罩与标注 overlay 应用成功");
  assert(await business.locator("[data-showit-overlay] .showit-mask").count() === 1, "遮罩元素已渲染");
  assert(await business.locator("[data-showit-overlay] .showit-circle").count() === 1, "圈选标注已渲染");
  assert(await business.locator("[data-showit-overlay] .showit-cover").count() === 0, "正常模式不渲染封面");

  const privacyOverlay = await business.evaluate(() => window.__sendShowitMessage({
    type: "showit-overlay",
    overlay: {
      sessionId: "session-smoke",
      pageId: "page-1",
      screenMode: "privacy",
      annotationTool: "none",
      circles: [],
      privacyMasks: [],
      offlineActive: false,
      brand: { primaryColor: "#37d0ba", privacyMessage: "画面已保护" }
    }
  }));
  assert(privacyOverlay?.ok === true, "隐私封面 overlay 应用成功");
  assert(await business.locator("[data-showit-overlay] .showit-cover").count() === 1, "隐私封面已渲染");
  await business.screenshot({ path: resolve(resultsDir, "extension-overlay.png") });

  console.log("全部冒烟断言通过。");
} finally {
  await context.close();
  server.close();
}
