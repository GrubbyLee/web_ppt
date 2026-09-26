import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = resolve(root, "test-results");
const appUrl = "http://127.0.0.1:4173";
await mkdir(artifacts, { recursive: true });

async function assertViewportFit(page, label) {
  const result = await page.evaluate(() => {
    const root = document.documentElement;
    const overflow = { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth };
    const selectors = "button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])";
    const offenders = [...document.querySelectorAll(selectors)]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && rect.width > 0
          && rect.height > 0
          && rect.bottom > 0
          && rect.top < innerHeight
          && (rect.left < -0.5 || rect.right > innerWidth + 0.5);
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return `${element.tagName.toLowerCase()}[${element.getAttribute("title") || element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 30) || "unnamed"}] ${rect.left.toFixed(1)}..${rect.right.toFixed(1)}`;
      });
    return { overflow, offenders };
  });
  assert.ok(result.overflow.scrollWidth <= result.overflow.clientWidth, `${label} horizontally overflows: ${result.overflow.scrollWidth}px > ${result.overflow.clientWidth}px`);
  assert.deepEqual(result.offenders, [], `${label} has controls outside the viewport: ${result.offenders.join(", ")}`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

try {
  const presenter = await context.newPage();
  await presenter.goto(`${appUrl}/#/presenter`);
  await presenter.waitForLoadState("networkidle");

  await presenter.getByText("Showit").first().waitFor({ state: "visible" });
  await presenter.getByText("LCAPIM 五角色治理闭环").first().waitFor({ state: "visible" });
  await presenter.getByText("本章计时", { exact: true }).waitFor({ state: "visible" });
  await presenter.locator(".business-frame-wrap iframe").waitFor({ state: "visible" });
  await presenter.waitForFunction(() => !document.querySelector(".stage-status-strip")?.textContent?.includes("正在检查"));
  assert.match(await presenter.locator(".business-frame-wrap iframe").getAttribute("src") ?? "", /\/console\/\?view=overview$/);
  await presenter.getByText("请先登录 系统管理员 演示账号，然后刷新业务页。", { exact: true }).waitFor({ state: "visible" });
  const accountDirectory = await (await context.request.get(`${appUrl}/api/lc/v1/demo/accounts`)).json();
  const administrator = accountDirectory.data.items.find((account) => account.role === "admin");
  assert.ok(administrator, "LCAPIM administrator demo account is unavailable");
  const login = await context.request.post(`${appUrl}/api/lc/v1/auth/login`, { data: { username: administrator.username, password: administrator.password, remember: true } });
  assert.equal(login.status(), 200);
  assert.equal((await context.request.post(`${appUrl}/api/lc/v1/reports`, { data: {} })).status(), 405);
  await presenter.getByTitle("刷新业务画面").click();
  await presenter.getByText("角色就绪", { exact: false }).first().waitFor({ state: "visible" });
  await presenter.locator(".business-frame-wrap iframe").contentFrame().locator("[data-page-title]").waitFor({ state: "visible" });
  await assertViewportFit(presenter, "presenter at 1440px");
  assert.equal(await presenter.locator(".page-grid").count(), 0);

  await presenter.getByTitle("打开页面选择网格").click();
  assert.equal(await presenter.locator(".page-grid button").count(), 18);
  await presenter.locator(".page-grid button").nth(1).click();
  await presenter.getByText("目录与五角色地图").first().waitFor({ state: "visible" });
  await presenter.locator(".business-frame-wrap iframe").waitFor({ state: "visible" });
  assert.match(await presenter.locator(".business-frame-wrap iframe").getAttribute("src") ?? "", /\/console\/\?view=overview$/);

  await presenter.getByTitle("开始或继续计时").click();
  await presenter.getByText("计时中").first().waitFor({ state: "visible" });
  await presenter.getByTitle("暂停计时").click();
  await presenter.getByText("已暂停").first().waitFor({ state: "visible" });

  const audienceUrl = await presenter.locator(".audience-link code").innerText();
  const audience = await context.newPage();
  await audience.goto(audienceUrl);
  await audience.waitForLoadState("networkidle");
  await audience.locator(".audience-window").waitFor({ state: "visible" });
  await audience.waitForFunction(() => document.querySelector(".audience-status strong")?.textContent?.includes("2/18"));
  await audience.locator(".audience-business-frame").waitFor({ state: "visible" });
  assert.match(await audience.locator(".audience-business-frame").getAttribute("src") ?? "", /\/console\/\?view=overview$/);

  await presenter.keyboard.press("l");
  const laserTool = presenter.getByTitle("启用激光笔（L）");
  assert.equal(await laserTool.getAttribute("aria-pressed"), "true");
  const annotationBox = await presenter.locator(".business-frame-wrap .annotation-layer").boundingBox();
  assert.ok(annotationBox);
  await presenter.mouse.move(annotationBox.x + annotationBox.width * 0.52, annotationBox.y + annotationBox.height * 0.46);
  const presenterLaser = presenter.locator(".annotation-layer__laser");
  const audienceLaser = audience.locator(".annotation-layer__laser");
  await presenterLaser.waitFor({ state: "visible" });
  await audienceLaser.waitFor({ state: "visible" });
  const laserBox = await presenterLaser.boundingBox();
  assert.ok(laserBox);
  assert.ok(Math.abs(laserBox.width - laserBox.height) < 0.5, `laser cursor must stay circular, got ${laserBox.width}x${laserBox.height}`);
  await presenter.screenshot({ path: resolve(artifacts, "presenter-laser-1440.png"), fullPage: true });
  await audience.screenshot({ path: resolve(artifacts, "audience-laser-1440.png"), fullPage: true });
  await presenter.mouse.move(0, 0);
  await presenterLaser.waitFor({ state: "hidden" });
  await audienceLaser.waitFor({ state: "hidden" });
  await presenter.keyboard.press("l");
  assert.equal(await laserTool.getAttribute("aria-pressed"), "false");

  await presenter.keyboard.press("PageDown");
  await presenter.getByText("LCAPIM 产品与实现边界").first().waitFor({ state: "visible" });
  assert.match(await presenter.locator(".business-frame-wrap iframe").getAttribute("src") ?? "", /\/console\/\?view=admin$/);
  await presenter.keyboard.press("PageUp");
  await presenter.getByText("目录与五角色地图").first().waitFor({ state: "visible" });
  await presenter.keyboard.press("ArrowDown");
  await presenter.getByText("LCAPIM 产品与实现边界").first().waitFor({ state: "visible" });
  await presenter.keyboard.press("ArrowUp");
  await presenter.getByText("目录与五角色地图").first().waitFor({ state: "visible" });
  await presenter.keyboard.press("End");
  await presenter.getByText("收束与问答").first().waitFor({ state: "visible" });
  await presenter.keyboard.press("Home");
  await presenter.getByText("LCAPIM 五角色治理闭环").first().waitFor({ state: "visible" });
  await presenter.keyboard.press("PageDown");
  await presenter.getByText("目录与五角色地图").first().waitFor({ state: "visible" });

  await presenter.keyboard.press("c");
  assert.equal(await presenter.getByTitle("启用圈选（C）").getAttribute("aria-pressed"), "true");
  await presenter.keyboard.press("Escape");
  assert.equal(await presenter.getByTitle("启用圈选（C）").getAttribute("aria-pressed"), "false");
  await presenter.keyboard.press("Escape");
  await presenter.locator(".page-grid").waitFor({ state: "visible" });
  await presenter.keyboard.press("Escape");
  await presenter.locator(".page-grid").waitFor({ state: "hidden" });

  await presenter.keyboard.press("b");
  await audience.locator(".audience-cover--black").waitFor({ state: "visible" });
  await presenter.keyboard.press("Escape");
  await audience.locator(".audience-cover--black").waitFor({ state: "hidden" });
  await presenter.keyboard.press("w");
  await audience.locator(".audience-cover--white").waitFor({ state: "visible" });
  await presenter.keyboard.press("Escape");
  await audience.locator(".audience-cover--white").waitFor({ state: "hidden" });
  const frozenAudiencePage = await audience.locator(".audience-status strong").innerText();
  const frozenAudienceFrame = await audience.locator(".audience-business-frame").getAttribute("src");
  await presenter.keyboard.press("f");
  await audience.locator(".audience-freeze-indicator").waitFor({ state: "visible" });
  await presenter.keyboard.press("PageDown");
  await presenter.getByText("LCAPIM 产品与实现边界").first().waitFor({ state: "visible" });
  await presenter.waitForTimeout(250);
  assert.equal(await audience.locator(".audience-status strong").innerText(), frozenAudiencePage);
  assert.equal(await audience.locator(".audience-business-frame").getAttribute("src"), frozenAudienceFrame);
  await presenter.keyboard.press("f");
  await audience.locator(".audience-freeze-indicator").waitFor({ state: "hidden" });
  await audience.waitForFunction(() => document.querySelector(".audience-status strong")?.textContent?.includes("3/18"));
  await audience.locator(".audience-business-frame").waitFor({ state: "visible" });
  assert.match(await audience.locator(".audience-business-frame").getAttribute("src") ?? "", /\/console\/\?view=admin$/);
  await presenter.keyboard.press("PageUp");
  await presenter.getByText("目录与五角色地图").first().waitFor({ state: "visible" });

  await presenter.keyboard.press("a");
  assert.equal(await presenter.getByTitle("切换自动翻页").getAttribute("aria-pressed"), "true");
  await presenter.keyboard.press("a");
  assert.equal(await presenter.getByTitle("切换自动翻页").getAttribute("aria-pressed"), "false");
  await presenter.keyboard.press("r");
  await presenter.getByTitle("结束并保存排练记录").waitFor({ state: "visible" });
  await presenter.keyboard.press("r");
  await presenter.getByTitle("从第一页开始排练").waitFor({ state: "visible" });
  await presenter.keyboard.press("Shift+/");
  await presenter.getByText("演示设置", { exact: true }).waitFor({ state: "visible" });
  await presenter.keyboard.press("Escape");
  await presenter.getByText("演示设置", { exact: true }).waitFor({ state: "hidden" });
  await presenter.keyboard.press("PageDown");
  await presenter.getByText("目录与五角色地图").first().waitFor({ state: "visible" });

  await presenter.getByTitle("下个页面").click();
  await presenter.getByText("LCAPIM 产品与实现边界").first().waitFor({ state: "visible" });
  await audience.waitForFunction(() => document.querySelector(".audience-status strong")?.textContent?.includes("3/18"));

  await presenter.screenshot({ path: resolve(artifacts, "presenter-1440.png"), fullPage: true });
  await audience.screenshot({ path: resolve(artifacts, "audience-1440.png"), fullPage: true });

  await presenter.setViewportSize({ width: 1024, height: 768 });
  await assertViewportFit(presenter, "presenter at 1024px");
  await presenter.screenshot({ path: resolve(artifacts, "presenter-1024.png"), fullPage: true });

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 375, height: 812 });
  await mobile.goto(`${appUrl}/#/presenter`);
  await mobile.waitForLoadState("networkidle");
  await mobile.locator(".presenter-shell").waitFor({ state: "visible" });
  await assertViewportFit(mobile, "presenter at 375px");
  await mobile.screenshot({ path: resolve(artifacts, "presenter-375.png"), fullPage: true });
  await context.request.post(`${appUrl}/api/lc/v1/session/logout`, { data: {} });
} finally {
  await browser.close();
}
