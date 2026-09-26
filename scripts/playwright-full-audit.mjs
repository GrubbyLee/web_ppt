import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = resolve(root, "test-results");
const appUrl = "http://127.0.0.1:4173";
const expectedViews = [
  "overview", "overview", "admin", "overview", "portal", "marketplace",
  "applications", "subscriptions", "studio", "studio-details", "registry",
  "overview", "approvals", "operations", "admin", "admin-controls", "admin", "overview"
];
const report = { startedAt: new Date().toISOString(), checks: [], failures: [], browserErrors: [] };

await mkdir(artifacts, { recursive: true });

async function check(name, action) {
  const started = Date.now();
  try {
    await action();
    report.checks.push({ name, ok: true, elapsedMs: Date.now() - started });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.checks.push({ name, ok: false, elapsedMs: Date.now() - started, message });
    report.failures.push({ name, message });
  }
}

async function viewportFits(page, label) {
  const result = await page.evaluate(() => {
    const root = document.documentElement;
    const offenders = [...document.querySelectorAll("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
          && rect.bottom > 0 && rect.top < innerHeight && (rect.left < -0.5 || rect.right > innerWidth + 0.5);
      })
      .map((element) => element.getAttribute("title") || element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 40) || element.tagName);
    return { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, offenders };
  });
  assert.ok(result.scrollWidth <= result.clientWidth, `${label}: ${result.scrollWidth}px > ${result.clientWidth}px`);
  assert.deepEqual(result.offenders, [], `${label}: controls outside viewport: ${result.offenders.join(", ")}`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (error) => report.browserErrors.push({ source: "page", message: error.message }));
page.on("console", (message) => {
  if (message.type() === "error") report.browserErrors.push({ source: "console", message: message.text() });
});

try {
  await check("项目库桌面布局", async () => {
    await page.goto(`${appUrl}/#/projects`);
    await page.waitForLoadState("networkidle");
    await page.locator(".project-workspace").waitFor({ state: "visible" });
    await page.getByText("LCAPIM 五角色治理闭环", { exact: true }).waitFor({ state: "visible" });
    await viewportFits(page, "项目库桌面布局");
  });

  await check("项目编辑器 18 页", async () => {
    await page.goto(`${appUrl}/#/projects/lc-apim-five-role-demo/edit`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("页面标题").waitFor({ state: "visible" });
    assert.equal(await page.locator(".editor-page-item").count(), 18);
    for (let index = 0; index < 18; index += 1) {
      await page.locator(".editor-page-item").nth(index).click();
      assert.ok((await page.getByLabel("页面标题").inputValue()).trim(), `editor page ${index + 1} has no title`);
      assert.match(await page.getByLabel("业务 URL 模板").inputValue(), new RegExp(`/console/\\?view=${expectedViews[index]}$`));
    }
    await viewportFits(page, "项目编辑器桌面布局");
  });

  await page.goto(`${appUrl}/#/projects`);
  await page.waitForLoadState("networkidle");
  const sampleRow = page.locator(".project-row").filter({ hasText: "LCAPIM 五角色治理闭环" }).first();
  await sampleRow.getByTitle("启动演示运行时").click();
  const trustButton = page.getByRole("button", { name: "重新信任并运行", exact: true });
  if (await trustButton.waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false)) await trustButton.click();
  await page.locator(".presenter-shell").waitFor({ state: "visible" });
  const accountsResponse = await context.request.get(`${appUrl}/api/lc/v1/demo/accounts`);
  assert.equal(accountsResponse.status(), 200);
  const accounts = (await accountsResponse.json()).data.items;
  const administrator = accounts.find((account) => account.role === "admin");
  assert.ok(administrator);
  assert.equal((await context.request.post(`${appUrl}/api/lc/v1/auth/login`, { data: administrator })).status(), 200);

  await check("演讲者提词模式", async () => {
    await page.keyboard.press("p");
    await page.locator(".presenter-shell.is-prompter").waitFor({ state: "visible" });
    assert.equal(await page.locator(".stage-panel").evaluate((element) => getComputedStyle(element).display), "none");
    await page.locator(".notes-panel").waitFor({ state: "visible" });
    assert.equal(await page.getByTitle("切换提词模式（P）").getAttribute("aria-pressed"), "true");
    await page.keyboard.press("Escape");
    await page.locator(".presenter-shell.is-prompter").waitFor({ state: "hidden" });
  });

  await check("演讲者 18 个真实业务页面", async () => {
    for (let index = 0; index < 18; index += 1) {
      await page.getByTitle("打开页面选择网格").click();
      await page.locator(".page-grid button").nth(index).click();
      await page.locator(`.business-frame-wrap iframe[src$="/console/?view=${expectedViews[index]}"]`).waitFor({ state: "visible" });
      const frameElement = page.locator(".business-frame-wrap iframe");
      assert.match(await frameElement.getAttribute("src") ?? "", new RegExp(`/console/\\?view=${expectedViews[index]}$`));
      const frame = frameElement.contentFrame();
      await frame.locator("[data-page-title]").waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(await page.locator(".business-frame-error").count(), 0);
      await page.waitForFunction(() => {
        const strip = document.querySelector(".stage-status-strip");
        return Boolean(strip) && !strip.textContent?.includes("正在检查");
      });
      const frameWidth = await frame.locator("html").evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
      assert.ok(frameWidth.scroll <= frameWidth.client + 1, `business page ${index + 1} horizontally overflows`);
    }
    await viewportFits(page, "演讲者桌面布局");
  });

  await check("观众屏冻结与恢复", async () => {
    await page.getByTitle("打开页面选择网格").click();
    await page.locator(".page-grid button").nth(1).click();
    const audienceUrl = await page.locator(".audience-link code").innerText();
    const audience = await context.newPage();
    audience.on("pageerror", (error) => report.browserErrors.push({ source: "audience", message: error.message }));
    await audience.goto(audienceUrl);
    await audience.waitForLoadState("networkidle");
    await audience.locator(".audience-business-frame").waitFor({ state: "visible" });
    await audience.waitForFunction(() => document.querySelector(".audience-status strong")?.textContent?.includes("2/18"));
    const frozenPage = await audience.locator(".audience-status strong").innerText();
    const frozenSrc = await audience.locator(".audience-business-frame").getAttribute("src");
    await page.keyboard.press("f");
    await audience.locator(".audience-freeze-indicator").waitFor({ state: "visible" });
    await page.keyboard.press("PageDown");
    await page.waitForTimeout(1_200);
    assert.equal(await audience.locator(".audience-status strong").innerText(), frozenPage);
    assert.equal(await audience.locator(".audience-business-frame").getAttribute("src"), frozenSrc);
    await page.keyboard.press("f");
    await audience.locator(".audience-freeze-indicator").waitFor({ state: "hidden" });
    await audience.waitForFunction(() => document.querySelector(".audience-status strong")?.textContent?.includes("3/18"));
    await viewportFits(audience, "观众屏桌面布局");
    await audience.close();
  });

  await check("项目库移动布局", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${appUrl}/#/projects`);
    await page.waitForLoadState("networkidle");
    await page.locator(".project-workspace").waitFor({ state: "visible" });
    await viewportFits(page, "项目库移动布局");
  });

  await check("演讲者最小支持布局", async () => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.goto(`${appUrl}/#/presenter/lc-apim-five-role-demo`);
    await page.waitForLoadState("networkidle");
    await page.locator(".presenter-shell").waitFor({ state: "visible" });
    await viewportFits(page, "演讲者最小支持布局");
  });

  await check("浏览器运行时无异常", async () => {
    assert.deepEqual(report.browserErrors, []);
  });
} finally {
  await context.request.post(`${appUrl}/api/lc/v1/session/logout`, { data: {} }).catch(() => undefined);
  await browser.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(artifacts, "full-audit-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

if (report.failures.length > 0) {
  console.error(JSON.stringify(report.failures, null, 2));
  process.exitCode = 1;
} else {
  console.log(`Full UI audit passed: ${report.checks.length} checks, 18 business pages.`);
}
