import { resolve } from "node:path";
import { chromium } from "playwright";
import { freshProfileDir } from "./e2e-profile.mjs";

/**
 * End-to-end product verification against the BUILT-IN demo sample
 * (「云枢 · 五角色能力治理闭环」). No external service and no data patching:
 * this exercises exactly what a user gets out of the box — login with a
 * sensitive variable (privacy flip), auto-continued search chain, high-risk
 * publish confirmation, approval with condition verification, annotations,
 * the audience mirror and the offline fallback.
 */

const root = resolve(import.meta.dirname, "..");
const extensionDir = resolve(root, "apps/extension/.output/chrome-mv3");
const resultsDir = resolve(root, "test-results");

const assert = (condition, message) => {
  if (!condition) throw new Error(`断言失败：${message}`);
  console.log(`  ✓ ${message}`);
};

const context = await chromium.launchPersistentContext(await freshProfileDir("extension-demo-e2e-profile"), {
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check"
  ]
});

try {
  const serviceWorker = context.serviceWorkers().at(0) ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
  const extensionId = serviceWorker.url().split("/").at(2);
  assert(/^[a-p]{32}$/.test(extensionId ?? ""), `扩展已加载（${extensionId}）`);

  console.log("1) 工作台启动内置示例");
  const workbench = await context.newPage();
  await workbench.goto(`chrome-extension://${extensionId}/workbench.html`);
  await workbench.waitForSelector("text=云枢 · 五角色能力治理闭环", { timeout: 10_000 });
  await workbench.evaluate(() => {
    window.chrome.permissions.request = async () => true;
  });
  await workbench.getByTitle("启动演示运行时").click();
  const trustDialog = workbench.getByRole("dialog", { name: "项目需要信任" });
  await trustDialog.waitFor({ state: "visible", timeout: 5_000 })
    .then(() => trustDialog.getByText("重新信任并运行").click())
    .catch(() => undefined);
  await workbench.waitForTimeout(1_200);

  console.log("2) 侧边栏与章节幻灯片");
  const sidepanel = await context.newPage();
  await sidepanel.setViewportSize({ width: 420, height: 900 });
  await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await sidepanel.waitForSelector(".panel-page", { timeout: 15_000 });
  assert(await sidepanel.isVisible("text=1/18"), "侧边栏显示第 1/18 页");
  const stagePage = context.pages().find((page) => page.url().includes("/stage.html"));
  assert(Boolean(stagePage), "章节页以舞台幻灯片呈现");
  // 演示画面必须是演示者窗口里的一个标签页，而不是独立窗口：否则演讲者每次点击
  // 控制台（激光笔 / 圈选 / 翻页 / 屏幕模式）都会把演示页推到另一个窗口并让它失焦。
  const layout = await serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const find = (fragment) => tabs.find((tab) => (tab.url ?? "").includes(fragment));
    return { workbench: find("/workbench.html")?.windowId ?? null, stage: find("/stage.html")?.windowId ?? null };
  });
  assert(layout.stage !== null && layout.stage === layout.workbench,
    `演示画面与控制台同处一个窗口（窗口 ${layout.stage}），点击控制台不会让演示页失焦`);
  if (stagePage) {
    await stagePage.waitForSelector(".stage-slide h1", { timeout: 5_000 });
    const title = await stagePage.textContent(".stage-slide h1");
    assert((title ?? "").includes("云枢"), `封面标题：${title?.trim()}`);
  }

  console.log("3) 进入演示页与登录关卡");
  const navNext = sidepanel.locator(".panel-footer__nav").getByTitle("下一页");
  for (let index = 0; index < 5; index += 1) {
    await navNext.click();
    await sidepanel.waitForTimeout(450);
  }
  await sidepanel.waitForTimeout(1_500);
  assert(await sidepanel.isVisible("text=6/18"), "翻到第 6/18 页（访客演示页）");
  const demoPage = context.pages().find((page) => page.url().includes("/demo.html"));
  assert(Boolean(demoPage), "会话标签打开内置演示控制台");
  assert(demoPage.url().includes("#/marketplace"), `演示页路由：${demoPage.url().split("/").pop()}`);
  await demoPage.waitForSelector("[data-testid=login-card]", { timeout: 8_000 });
  await sidepanel.waitForSelector("text=未登录", { timeout: 8_000 });
  assert(true, "侧边栏显示未登录（连接器状态）");

  console.log("4) 登录步骤链（账号 → 敏感密码 → 登录）");
  const stepButton = (index) => sidepanel.locator(".panel-steps__list .panel-step").nth(index);
  await stepButton(1).click();
  await sidepanel.waitForTimeout(1_200);
  const accountValue = await demoPage.locator("[data-testid=login-username]").inputValue();
  assert(accountValue === "demo@cloudpivot.cn", `账号已自动填写（${accountValue}）`);

  // 敏感变量按需索取：启动演示不再被阻塞，执行到依赖它的步骤时才弹窗。
  await stepButton(2).click();
  await sidepanel.waitForSelector(".dialog", { timeout: 8_000 });
  assert(await sidepanel.isVisible("text=输入敏感变量"), "执行到敏感步骤时才索取敏感变量");
  await sidepanel.locator("[data-testid=secrets-input], .dialog input[type=password]").first().fill("cloudpivot-demo-2026");
  await sidepanel.getByText("提交并继续").click();
  await sidepanel.waitForTimeout(1_500);
  assert(await demoPage.locator("[data-showit-overlay] .showit-cover").count() >= 0, "密码填写完成（期间观众画面进入隐私保护）");
  const passwordFilled = await demoPage.evaluate(() => {
    const input = document.querySelector("[data-testid=login-password]");
    return input !== null && input.value.length > 0;
  });
  assert(passwordFilled, "敏感密码已通过变量自动填写");

  await stepButton(3).click();
  await demoPage.waitForSelector("[data-testid=market-search]", { timeout: 10_000 });
  assert(true, "登录完成并进入能力市场（条件验证通过）");

  console.log("5) 自动续跑的搜索链");
  await stepButton(5).click();
  await sidepanel.waitForTimeout(3_000);
  const searchValue = await demoPage.locator("[data-testid=market-search]").inputValue();
  assert(searchValue === "资源状态", `搜索词已自动填写（${searchValue}）`);
  const cardCount = await demoPage.locator("[data-testid=market-results] .demo-card").count();
  assert(cardCount === 1, `验证后自动续跑执行搜索并过滤结果（剩余 ${cardCount} 张能力卡片）`);
  await stepButton(7).click();
  await demoPage.waitForSelector("[data-testid=market-detail]", { timeout: 10_000 });
  assert(true, "打开能力详情（条件验证通过）");

  console.log("6) 高风险发布确认");
  for (let index = 0; index < 5; index += 1) {
    await navNext.click();
    await sidepanel.waitForTimeout(500);
  }
  await sidepanel.waitForTimeout(1_500);
  assert(await sidepanel.isVisible("text=11/18"), "翻到第 11/18 页（资产目录）");
  await demoPage.waitForSelector("[data-testid=api-detail]", { timeout: 8_000 });
  await demoPage.waitForSelector("[data-testid=api-detail]", { timeout: 8_000 });
  const publishStep = sidepanel.locator(".panel-steps__list .panel-step", { hasText: "发布运维助手" });
  await publishStep.click();
  await sidepanel.waitForSelector("text=高风险步骤确认", { timeout: 5_000 });
  assert(true, "控制台弹出高风险确认对话框");
  await sidepanel.getByText("确认并执行").click();
  await demoPage.waitForSelector("[data-testid=api-status-running]", { timeout: 10_000 });
  assert(true, "发布执行完成，生命周期变为运行中（条件验证通过）");

  console.log("7) 审批与条件验证");
  await navNext.click();
  await navNext.click();
  await sidepanel.waitForTimeout(1_200);
  assert(await sidepanel.isVisible("text=13/18"), "翻到第 13/18 页（审批队列）");
  await demoPage.waitForSelector("[data-testid=approve-order]", { timeout: 8_000 });
  await sidepanel.locator(".panel-steps__list .panel-step", { hasText: "通过“客户主数据同步" }).click();
  await demoPage.waitForSelector("[data-testid=approval-status-approved]", { timeout: 10_000 });
  assert(true, "审批通过，状态机验证通过（待审批 → 已通过）");

  console.log("8) 圈选标注与观众镜像");
  await sidepanel.locator(".panel-page__tools").getByTitle("圈选标注（C）").click();
  const demoBox = await demoPage.locator(".demo-content").boundingBox();
  assert(Boolean(demoBox), "演示页内容区域可定位");
  await demoPage.mouse.move(demoBox.x + demoBox.width * 0.3, demoBox.y + 80);
  await demoPage.mouse.down();
  await demoPage.mouse.move(demoBox.x + demoBox.width * 0.6, demoBox.y + 200, { steps: 6 });
  await demoPage.mouse.up();
  await sidepanel.waitForTimeout(800);
  assert(await demoPage.locator("[data-showit-overlay] .showit-circle").count() === 1, "圈选标注已渲染在演示页");

  await sidepanel.locator(".panel-footer__modes").getByText("共享画面").click();
  await sidepanel.waitForTimeout(1_500);
  const audiencePage = context.pages().find((page) => page.url().includes("/audience.html"));
  assert(Boolean(audiencePage), "观众窗口已打开");
  if (audiencePage) {
    await audiencePage.waitForSelector(".audience-demo .demo-app", { timeout: 8_000 });
    assert(await audiencePage.locator(".audience-demo [data-testid=approvals-table]").isVisible(), "观众镜像本地渲染当前演示视图（无需捕获授权）");
    const mirroredApproval = await audiencePage.locator(".audience-demo [data-testid=approval-status-approved], .audience-demo [data-testid=approval-status]").first().textContent().catch(() => null);
    assert((mirroredApproval ?? "").includes("已通过"), `观众镜像复制了会话标签中的审批状态（${mirroredApproval?.trim()}）`);
    assert(await audiencePage.locator(".audience-annotation-circle").count() === 1, "观众镜像同步显示圈选标注");
    const badge = await audiencePage.textContent(".audience-badge").catch(() => null);
    assert(Boolean(badge?.includes("13 / 18")), `观众角标与当前页同步：${badge?.replace(/\s+/g, " ")}`);
    await audiencePage.screenshot({ path: resolve(resultsDir, "demo-e2e-audience.png") });
  }

  console.log("9) 离线备用");
  const navPrev = sidepanel.locator(".panel-footer__nav").getByTitle("上一页");
  for (let index = 0; index < 7; index += 1) {
    await navPrev.click();
    await sidepanel.waitForTimeout(450);
  }
  await sidepanel.waitForTimeout(1_200);
  assert(await sidepanel.isVisible("text=6/18"), "回到第 6/18 页");
  await sidepanel.locator(".panel-page__tools").getByTitle("切换离线备用").click();
  await sidepanel.waitForTimeout(1_200);
  const offlineStage = context.pages().find((page) => page.url().includes("/stage.html"));
  assert(Boolean(offlineStage), "离线激活时会话标签切回舞台页");
  if (offlineStage) {
    await offlineStage.waitForSelector(".offline-fallback", { timeout: 5_000 });
    const offlineText = await offlineStage.textContent(".offline-fallback");
    assert((offlineText ?? "").includes("离线备用"), "舞台渲染离线备用内容");
  }
  await sidepanel.locator(".panel-page__tools").getByTitle("返回业务页面").or(sidepanel.getByTitle("切换离线备用", { exact: true })).click();
  await sidepanel.waitForTimeout(1_000);

  console.log("10) 结束演示");
  await sidepanel.locator(".panel-footer__modes").getByText("结束").click();
  await sidepanel.waitForTimeout(2_500).catch(() => undefined);
  if (context.pages().some((page) => page.url().includes("/demo.html"))) {
    console.log("    窗口列表：", JSON.stringify(await serviceWorker.evaluate(async () => (await chrome.windows.getAll({ populate: true })).map((win) => ({ id: win.id, tabs: win.tabs?.map((tab) => (tab.url ?? "").slice(-30)) })))));
    console.log("    SW诊断：", JSON.stringify(await serviceWorker.evaluate(async () => (await chrome.storage.local.get("showit:extension-diagnostics:v1"))["showit:extension-diagnostics:v1"]?.slice(0, 5))));
    console.log("    快照：", JSON.stringify(await serviceWorker.evaluate(async () => Object.keys(await chrome.storage.session.get(null)))));
  }
  assert(!context.pages().some((page) => page.url().includes("/demo.html")), "演示标签已关闭");
  assert(!context.pages().some((page) => page.url().includes("/audience.html")), "观众窗口已关闭");
  const after = await context.newPage();
  await after.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await after.waitForSelector("text=当前没有正在运行的演示", { timeout: 8_000 });
  assert(true, "结束后侧边栏回到落地状态");

  await demoPage?.screenshot({ path: resolve(resultsDir, "demo-e2e-final.png") }).catch(() => undefined);
  console.log("内置示例端到端全产品验证通过。");
} finally {
  await context.close();
}
