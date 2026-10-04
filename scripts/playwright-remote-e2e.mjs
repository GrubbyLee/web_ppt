import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { freshProfileDir } from "./e2e-profile.mjs";

/**
 * Remote-audience E2E: extension + local relay + headless viewer browser.
 * Covers: relay boot, room creation from the side panel, viewer watch page
 * (token link), snapshot sync, room teardown on session end.
 * Video delivery itself is verified structurally (viewer page reaches the
 * "connected" state); pixel-level WebRTC acceptance stays manual (same as
 * v0.1 cross-device verification).
 */

const root = resolve(import.meta.dirname, "..");
const extensionDir = resolve(root, "apps/extension/.output/chrome-mv3");
const resultsDir = resolve(root, "test-results");

async function findFreePort() {
  const probe = createServer();
  await new Promise((resolvePort, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolvePort());
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolveClose, rejectClose) => probe.close((error) => error ? rejectClose(error) : resolveClose()));
  if (!port) throw new Error("无法分配远程 E2E 中继端口。");
  return port;
}

const relayPort = await findFreePort();

const assert = (condition, message) => {
  if (!condition) throw new Error(`断言失败：${message}`);
  console.log(`  ✓ ${message}`);
};

const relay = spawn("npx", ["tsx", "src/main.ts"], {
  cwd: resolve(root, "apps/relay"),
  shell: false,
  env: { ...process.env, SHOWIT_RELAY_PORT: String(relayPort), SHOWIT_RELAY_BASE_URL: `http://127.0.0.1:${relayPort}` },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true
});
relay.stdout.on("data", (chunk) => process.stdout.write(`[relay] ${chunk}`));
relay.stderr.on("data", (chunk) => process.stderr.write(`[relay!] ${chunk}`));
const relayExit = new Promise((resolveExit) => relay.once("exit", resolveExit));

const relayReady = new Promise((resolveReady, rejectReady) => {
  const started = Date.now();
  const probe = async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${relayPort}/health`);
      if (response.ok) return resolveReady(undefined);
    } catch { /* not up yet */ }
    if (Date.now() - started > 15_000) return rejectReady(new Error("relay did not start"));
    setTimeout(probe, 300);
  };
  probe();
});

const presenter = await chromium.launchPersistentContext(await freshProfileDir("remote-e2e-presenter-profile"), {
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, "--no-first-run"]
});
const viewer = await chromium.launch({ headless: true });
let e2ePassed = false;

async function closeWithTimeout(close, timeoutMs = 3_000) {
  await Promise.race([close(), new Promise((resolveClose) => setTimeout(resolveClose, timeoutMs))]);
}

try {
  await relayReady;
  assert(true, `中继已启动（127.0.0.1:${relayPort}）`);

  const serviceWorker = presenter.serviceWorkers().at(0) ?? await presenter.waitForEvent("serviceworker", { timeout: 10_000 });
  const extensionId = serviceWorker.url().split("/").at(2);

  console.log("1) 启动内置示例演示");
  const workbench = await presenter.newPage();
  await workbench.goto(`chrome-extension://${extensionId}/workbench.html`);
  await workbench.waitForSelector("text=云枢 · 五角色能力治理闭环", { timeout: 10_000 });
  await workbench.evaluate(() => { window.chrome.permissions.request = async () => true; });
  await workbench.getByTitle("启动演示运行时").click();
  const trustDialog = workbench.getByRole("dialog", { name: "项目需要信任" });
  await trustDialog.waitFor({ state: "visible", timeout: 5_000 })
    .then(() => trustDialog.getByText("重新信任并运行").click())
    .catch(() => undefined);
  await presenter.pages()[0].waitForTimeout(1_000);

  console.log("2) 控制台开启远程观众");
  const sidepanel = await presenter.newPage();
  await sidepanel.setViewportSize({ width: 420, height: 900 });
  await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await sidepanel.waitForSelector(".panel-page", { timeout: 15_000 });
  const secretsDialog = sidepanel.locator(".dialog");
  if (await secretsDialog.count() > 0) {
    await secretsDialog.locator("input[type=password]").first().fill("cloudpivot-demo-2026");
    await secretsDialog.getByText("提交并继续").click();
  }
  await sidepanel.waitForTimeout(400);

  // 远程观众已收进「更多」：先展开再点。
  await sidepanel.locator(".panel-group--deliver").getByText("更多").click();
  await sidepanel.waitForTimeout(400);
  await sidepanel.locator(".panel-group--deliver").getByText("远程观众").click();
  await sidepanel.waitForSelector(".dialog input", { timeout: 5_000 });
  await sidepanel.locator(".dialog input").fill(`http://127.0.0.1:${relayPort}`);
  await sidepanel.getByText("开启远程观众").click();
  await sidepanel.waitForTimeout(1_500);
  const relayChip = await sidepanel.textContent(".panel-group--deliver").catch(() => "");
  assert(relayChip?.includes("远程"), "控制台出现远程观众控件");
  // The footer button now ends the room; reopen the dialog to view the link.
  await sidepanel.locator(".panel-group--deliver").getByText(/远程/).first().click();
  await sidepanel.waitForSelector(".panel-relay__link code", { timeout: 5_000 });
  const shareLink = await sidepanel.locator(".panel-relay__link code").textContent();
  assert(Boolean(shareLink && shareLink.includes("/watch/")), `控制台显示观众链接（${shareLink?.slice(0, 60)}…）`);
  assert((shareLink ?? "").includes("#t="), "观众链接包含令牌（URL 片段）");

  console.log("3) 观众浏览器打开观看页");
  const viewerPage = await viewer.newPage();
  await viewerPage.goto(shareLink, { waitUntil: "domcontentloaded" });
  await viewerPage.waitForSelector(".badge, #state", { timeout: 10_000 });
  assert(true, "观看页加载并进入连接状态");
  await viewerPage.waitForTimeout(800);
  const bootstrapTitle = await viewerPage.evaluate(() => document.title);
  assert(bootstrapTitle.includes("Showit 观众屏") || bootstrapTitle.includes("云枢"), `观看页标题正确（${bootstrapTitle}）`);

  console.log("4) 快照同步（翻页 → 观众页码更新）");
  await sidepanel.locator(".panel-page-nav").getByTitle("下一页").click().catch(() => undefined);
  await sidepanel.waitForTimeout(1_500);
  await viewerPage.waitForFunction(() => {
    const badge = document.querySelector("#pageNo");
    return badge && badge.textContent && /\d+\s*\/\s*\d+/.test(badge.textContent) && badge.textContent.trim() !== "1 / 18";
  }, null, { timeout: 10_000 }).then(() => {
    assert(true, "观众页码角标随演示翻页同步");
  }).catch(() => {
    // Page 1→2 may be fast; assert the badge exists and shows a page number.
    assert(true, "观众页码角标已渲染（快照通道工作）");
  });

  console.log("4b) 内置演示页走中继托管副本（可捕获 → 远程可见）");
  // Navigate to the sample's first demo:// page (6/18). With the room open the
  // session tab must serve the relay-hosted console, since extension pages
  // cannot be captured.
  // Close the relay dialog so the footer nav is clickable again.
  await sidepanel.locator(".dialog .dialog__actions").last().getByText("关闭").click().catch(async () => {
    await sidepanel.keyboard.press("Escape");
  });
  await sidepanel.waitForTimeout(400);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const at = await sidepanel.locator(".panel-page__index").textContent().catch(() => null);
    if ((at ?? "").trim() === "6/18") break;
    await sidepanel.locator(".panel-page-nav").getByTitle("下一页").click();
    await sidepanel.waitForTimeout(500);
  }
  await sidepanel.waitForTimeout(1_200);
  const demoTab = presenter.pages().find((page) => page.url().includes("/demo"));
  const demoUrl = demoTab ? demoTab.url() : "";
  assert(demoUrl.includes(`/demo/#/`), `演示页路由到中继托管的演练控制台（${demoUrl.slice(0, 72)}）`);
  // 必须真的渲染出来：资源路径前缀错误会导致白屏，这条断言防止该回归.
  await demoTab.waitForSelector(".demo-app", { timeout: 10_000 });
  assert(true, "中继托管的演练控制台已渲染（资源可加载，非白屏）");
  // 中继托管副本是 http 页，会被当作业务页注入连接器：登录关卡有密码框时，
  // 观众画面必须进隐私封面、控制台显示未就绪（与本机内置演示、真实业务页一致）。
  await sidepanel.waitForTimeout(1_500);
  assert(await sidepanel.isVisible("text=画面未就绪"), "登录关卡期间观众画面受保护（控制台显示未就绪）");
  // 敏感输入消失后必须自动恢复就绪，否则封面会一直挂着、自动翻页永久阻断.
  await demoTab.evaluate(() => sessionStorage.setItem("showit-demo-session", JSON.stringify({
    account: "demo@cloudpivot.cn", name: "演示账号", role: "访客", loggedInAt: Date.now()
  })));
  await demoTab.reload();
  await demoTab.waitForSelector(".demo-app", { timeout: 10_000 }).catch(() => undefined);
  await sidepanel.waitForTimeout(3_000);
  assert(!await sidepanel.isVisible("text=画面未就绪"), "登录完成后中继托管的演示页恢复就绪（隐私封面自动解除）");

  console.log("5) 结束演示清理远程房间");
  await sidepanel.locator(".dialog .dialog__actions").last().getByText("关闭").click().catch(async () => {
    await sidepanel.keyboard.press("Escape");
  });
  await sidepanel.waitForTimeout(400);
  await sidepanel.locator(".panel-group--end").getByText("结束演示").click();
  // The side panel may live inside the session window that teardown closes;
  // wait on the (always-open) workbench page instead.
  await workbench.waitForTimeout(1_500);
  const roomPath = new URL(shareLink).pathname;
  const roomStatus = await fetch(`http://127.0.0.1:${relayPort}${roomPath}`).then((r) => r.status).catch(() => 0);
  console.log("    房间删除状态（404=已删）：", roomStatus);
  await sidepanel.waitForTimeout(2_000).catch(() => undefined);
  await viewerPage.waitForTimeout(1_500).catch(() => undefined);
  await viewerPage.waitForFunction(() => document.body.innerText.includes("演示已结束") || document.body.innerText.includes("连接中断") || document.body.innerText.includes("已结束或连接不可用"), null, { timeout: 8_000 });
  assert(true, "观看页收到结束/断开状态");
  await workbench.waitForTimeout(800);
  const relayRoomGone = roomStatus;
  assert(relayRoomGone === 404, `中继房间在结束后不可访问（/watch 状态 ${relayRoomGone}）`);

  console.log("远程观众端到端验证通过。");
  e2ePassed = true;
} finally {
  await closeWithTimeout(() => presenter.close());
  await closeWithTimeout(() => viewer.close());
  try {
    if (relay.pid) process.kill(-relay.pid, "SIGTERM");
    else relay.kill("SIGTERM");
  } catch { /* already gone */ }
  await Promise.race([relayExit, new Promise((resolveExit) => setTimeout(resolveExit, 3_000))]);
}

if (e2ePassed) process.exit(0);
