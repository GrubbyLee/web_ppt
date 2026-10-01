import { createServer } from "node:http";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { freshProfileDir } from "./e2e-profile.mjs";

const root = resolve(import.meta.dirname, "..");
const resultsDir = resolve(root, "test-results");
const businessPort = 8907;

// Build a test copy of the extension with the fixture host pre-granted so the
// launch flow does not depend on a native permission prompt.
const sourceDir = resolve(root, "apps/extension/.output/chrome-mv3");
const extensionDir = resolve(resultsDir, "extension-e2e-build");
await rm(extensionDir, { recursive: true, force: true });
await cp(sourceDir, extensionDir, { recursive: true });
const manifestPath = resolve(extensionDir, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.host_permissions = [`http://127.0.0.1:${businessPort}/*`];
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

const businessHtml = (requestUrl) => {
  const showLogin = new URL(requestUrl, `http://127.0.0.1:${businessPort}`).searchParams.get("login") === "1";
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>LCAPIM 控制台</title></head>
<body>
  <main>
    <h1>能力开放平台</h1>
    ${showLogin ? '<label>登录密码 <input id="login-password" type="password" autocomplete="current-password"></label>' : ""}
    <label>搜索 <input id="api-search" data-testid="api-search" autocomplete="off"></label>
    <button type="button" data-testid="publish-api" aria-label="发布能力">发布能力</button>
    <p id="status-line">就绪</p>
  </main>
</body>
</html>`;
};

const server = createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(businessHtml(request.url ?? "/"));
});
await new Promise((resolvePromise) => server.listen(businessPort, "127.0.0.1", resolvePromise));

const assert = (condition, message) => {
  if (!condition) throw new Error(`断言失败：${message}`);
  console.log(`  ✓ ${message}`);
};

const context = await chromium.launchPersistentContext(await freshProfileDir("extension-e2e-profile"), {
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--auto-accept-this-tab-capture"
  ]
});

try {
  const serviceWorker = context.serviceWorkers().at(0) ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
  const extensionId = serviceWorker.url().split("/").at(2);
  assert(/^[a-p]{32}$/.test(extensionId ?? ""), `扩展已加载（${extensionId}）`);

  console.log("1) 工作台启动演示");
  const workbench = await context.newPage();
  await workbench.goto(`chrome-extension://${extensionId}/workbench.html`);
  await workbench.waitForSelector("text=云枢 · 五角色能力治理闭环", { timeout: 10_000 });
  // Point ONE live page of the bundled sample at the local fixture service so
  // the session tab has a real HTTP business page (content-script injection,
  // probe, capture authorization guidance).
  await workbench.evaluate(async (port) => {
    const db = await new Promise((resolveDb, rejectDb) => {
      const request = indexedDB.open("showit", 1);
      request.onsuccess = () => resolveDb(request.result);
      request.onerror = () => rejectDb(request.error);
    });
    const workspace = await new Promise((resolveItem, rejectItem) => {
      const tx = db.transaction(["workspaces"], "readonly");
      const request = tx.objectStore("workspaces").getAll();
      request.onsuccess = () => resolveItem(request.result[0]);
      request.onerror = () => rejectItem(request.error);
    });
    const page = workspace.project.pages.find((item) => item.id === "visitor-live-demo");
    page.url = `http://127.0.0.1:${port}/console/?view=marketplace`;
    await new Promise((resolveWrite, rejectWrite) => {
      const tx = db.transaction(["workspaces"], "readwrite");
      const request = tx.objectStore("workspaces").put(workspace);
      request.onsuccess = () => resolveWrite();
      request.onerror = () => rejectWrite(request.error);
    });
  }, businessPort);
  await workbench.reload();
  await workbench.waitForSelector("text=云枢 · 五角色能力治理闭环", { timeout: 10_000 });
  // Pre-grant optional host permissions so the launch flow does not open a native prompt.
  await workbench.evaluate(() => {
    window.chrome.permissions.request = async () => true;
  });
  await workbench.getByTitle("启动演示运行时").click();
  const trustDialog = workbench.getByRole("dialog", { name: "项目需要信任" });
  await trustDialog.waitFor({ state: "visible", timeout: 5_000 })
    .then(() => trustDialog.getByText("重新信任并运行").click())
    .catch(() => undefined);
  await workbench.waitForTimeout(1_000);

  console.log("2) 侧边栏会话状态");
  const sidepanel = await context.newPage();
  await sidepanel.setViewportSize({ width: 420, height: 900 });
  await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const panelReady = await sidepanel.waitForSelector(".panel-page", { timeout: 20_000 }).then(() => true, () => false);
  if (!panelReady) {
    console.log("    sidepanel text:", await sidepanel.evaluate(() => document.body.innerText.slice(0, 300)));
    console.log("    diagnostics:", JSON.stringify(await serviceWorker.evaluate(async () => (await chrome.storage.local.get("showit:extension-diagnostics:v1"))["showit:extension-diagnostics:v1"])));
    console.log("    machine snapshot:", JSON.stringify(await serviceWorker.evaluate(async () => (await chrome.storage.session.get("showit:machine-snapshot:v1"))["showit:machine-snapshot:v1"]?.machine?.session?.id ?? null)));
  }
  assert(panelReady, "侧边栏进入演示视图");
  assert(await sidepanel.isVisible("text=1/18"), "侧边栏显示第 1/18 页");
  await sidepanel.screenshot({ path: resolve(resultsDir, "e2e-sidepanel.png") });
  // The bundled sample declares a required sensitive variable — provide it so
  // the console is not blocked by the collection dialog.
  const secretsDialog = sidepanel.locator(".dialog");
  if (await secretsDialog.count() > 0) {
    await secretsDialog.locator("input[type=password]").first().fill("cloudpivot-demo-2026");
    await secretsDialog.getByText("提交并继续").click();
    await sidepanel.waitForTimeout(500);
  }

  console.log("3) 会话业务标签");
  const navNext = sidepanel.locator(".panel-footer__nav").getByTitle("下一页");
  for (let index = 0; index < 5; index += 1) {
    await navNext.click();
    await sidepanel.waitForTimeout(500);
  }
  await sidepanel.waitForTimeout(2_000);
  assert(await sidepanel.isVisible("text=6/18"), "翻到第 6/18 页（已改为 HTTP 业务页）");
  const businessPage = context.pages().find((page) => page.url().startsWith(`http://127.0.0.1:${businessPort}`));
  assert(Boolean(businessPage), "会话标签已打开并导航到业务页");
  if (businessPage) {
    await businessPage.waitForSelector("[data-showit-overlay]", { timeout: 8_000 });
    assert(await businessPage.locator("[data-showit-overlay]").count() === 1, "业务页连接器已注入");
    await businessPage.screenshot({ path: resolve(resultsDir, "e2e-business.png") });
  }
  await sidepanel.waitForSelector("text=业务页就绪", { timeout: 8_000 });
  assert(true, "侧边栏显示业务页就绪");

  console.log("4) 计时");
  await sidepanel.getByTitle("开始计时").or(sidepanel.getByTitle("计时")).first().click({ timeout: 3_000 }).catch(() => undefined);
  await sidepanel.waitForTimeout(1_200);
  const totalTimer = await sidepanel.locator(".panel-timers div").first().textContent();
  assert(Boolean(totalTimer && totalTimer.trim().length > 0), "计时器在渲染");

  console.log("5) 翻页导航");
  await sidepanel.locator(".panel-footer__nav").getByTitle("上一页").click();
  await sidepanel.waitForTimeout(1_200);
  assert(await sidepanel.isVisible("text=5/18"), "翻回第 5/18 页（章节幻灯片）");
  await sidepanel.locator(".panel-footer__nav").getByTitle("下一页").click();
  await sidepanel.waitForTimeout(1_500);
  assert(await sidepanel.isVisible("text=6/18"), "回到第 6/18 页");
  const businessUrl = businessPage ? await businessPage.url() : "";
  assert(businessUrl.includes("view="), `会话标签保持业务页面（${businessUrl}）`);

  console.log("5b) 登录表单的观众隐私保护");
  const cleanBusinessUrl = businessPage.url();
  await businessPage.goto(`${cleanBusinessUrl}&login=1`);
  await sidepanel.waitForSelector("text=业务页包含登录或敏感输入", { timeout: 10_000 });
  assert(true, "登录表单使侧边栏显示受阻（观众合成器进入隐私封面）");
  await businessPage.goto(cleanBusinessUrl);
  await sidepanel.waitForSelector("text=业务页就绪", { timeout: 10_000 });
  assert(true, "敏感输入消失后自动恢复就绪（观众封面解除）");

  console.log("6) 观众窗口与画面授权");
  await sidepanel.getByTitle("共享画面").or(sidepanel.locator("button", { hasText: "共享画面" })).first().click({ timeout: 3_000 }).catch(async () => {
    await sidepanel.locator(".panel-footer__modes").getByText("共享画面").click();
  });
  await sidepanel.waitForTimeout(2_000);
  const audiencePage = context.pages().find((page) => page.url().includes("/audience.html"));
  assert(Boolean(audiencePage), "观众窗口已打开");
  if (audiencePage) {
    await audiencePage.waitForTimeout(500);
    const badge = await audiencePage.textContent(".audience-badge").catch(() => null);
    assert(Boolean(badge), `观众窗口显示会话角标：${badge?.replace(/\s+/g, " ")}`);
    // tabCapture requires invoking the extension on the session tab — the
    // context-menu entry grants activeTab and triggers the capture retry.
    if (businessPage) {
      // tabCapture requires the extension to be invoked on the session tab
      // (toolbar icon click / context menu / Ctrl+Shift+9 — none of which can
      // be synthesized by automation). Assert the authorization guidance and
      // the state-sync data path instead; live video is a manual acceptance
      // step, exactly like v0.1's cross-device WebRTC verification.
      await sidepanel.waitForSelector("text=画面捕获需要授权", { timeout: 5_000 });
      assert(true, "侧边栏显示画面捕获授权引导");
      const badgeAfter = await audiencePage.textContent(".audience-badge").catch(() => null);
      assert(Boolean(badgeAfter?.includes("6 / 18")), "观众窗口角标与当前页保持同步");
    }
    await audiencePage.screenshot({ path: resolve(resultsDir, "e2e-audience.png") });
  }

  console.log("7) 结束演示");
  await sidepanel.locator(".panel-footer__modes").getByText("结束").click();
  const waitForPagesGone = async (predicate, label) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!context.pages().some(predicate)) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  };
  const businessGone = await waitForPagesGone((page) => page.url().startsWith(`http://127.0.0.1:${businessPort}`));
  if (!businessGone) {
    console.log("    pages:", JSON.stringify(context.pages().map((page) => page.url())));
    console.log("    diagnostics:", JSON.stringify(await serviceWorker.evaluate(async () => (await chrome.storage.local.get("showit:extension-diagnostics:v1"))["showit:extension-diagnostics:v1"])));
    console.log("    windows:", JSON.stringify(await serviceWorker.evaluate(async () => (await chrome.windows.getAll({ populate: true })).map((win) => ({ id: win.id, tabs: win.tabs?.map((tab) => tab.url?.slice(0, 60)) })))));
    console.log("    snapshot keys:", JSON.stringify(await serviceWorker.evaluate(async () => Object.keys(await chrome.storage.session.get(null)))));
    console.log("    sidepanel text:", await sidepanel.evaluate(() => document.body.innerText.slice(0, 200)).catch((error) => `closed: ${error.message.split("\n")[0]}`));
  }
  assert(businessGone, "会话业务标签已随演示结束关闭");
  const audienceGone = await waitForPagesGone((page) => page.url().includes("/audience.html"));
  assert(audienceGone, "观众窗口已随演示结束关闭");
  const sidepanelAfter = await context.newPage();
  await sidepanelAfter.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await sidepanelAfter.waitForSelector(".panel-library", { timeout: 8_000 });
  assert(true, "结束后侧边栏回到项目库 / 落地状态");
  const snapshotGone = await serviceWorker.evaluate(async () => (await chrome.storage.session.get("showit:machine-snapshot:v1"))["showit:machine-snapshot:v1"] === undefined);
  assert(snapshotGone, "运行快照已清除");

  console.log("端到端流程全部断言通过。");
} finally {
  await context.close();
  server.close();
}
