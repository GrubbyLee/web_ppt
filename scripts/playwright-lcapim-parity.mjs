import assert from "node:assert/strict";
import { chromium } from "playwright";

const appUrl = "http://127.0.0.1:4173";
const expectedViews = [
  "overview", "overview", "admin", "overview", "portal", "marketplace",
  "applications", "subscriptions", "studio", "studio-details", "registry",
  "overview", "approvals", "operations", "admin", "admin-controls", "admin", "overview"
];
const rolePages = new Map([
  ["admin", 0], ["guest", 4], ["consumer", 6], ["producer", 8], ["operator", 11]
]);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

async function selectPage(index) {
  await page.getByTitle("打开页面选择网格").click();
  await page.locator(".page-grid button").nth(index).click();
  await page.locator(".business-frame-wrap iframe").waitFor({ state: "visible" });
}

try {
  await page.goto(`${appUrl}/#/presenter/lc-apim-five-role-demo`);
  await page.waitForLoadState("networkidle");
  const directoryResponse = await context.request.get(`${appUrl}/api/lc/v1/demo/accounts`);
  assert.equal(directoryResponse.status(), 200);
  const accounts = (await directoryResponse.json()).data.items;

  const administrator = accounts.find((account) => account.role === "admin");
  assert.ok(administrator);
  assert.equal((await context.request.post(`${appUrl}/api/lc/v1/auth/login`, { data: administrator })).status(), 200);

  for (let index = 0; index < expectedViews.length; index += 1) {
    await selectPage(index);
    await page.getByTitle("刷新业务画面").click();
    assert.match(await page.locator(".business-frame-wrap iframe").getAttribute("src") ?? "", new RegExp(`/console/\\?view=${expectedViews[index]}$`));
    try {
      await page.locator(".business-frame-wrap iframe").contentFrame().locator("[data-page-title]").waitFor({ state: "visible", timeout: 10_000 });
    } catch (error) {
      throw new Error(`LCAPIM page ${index + 1} (${expectedViews[index]}) did not render its business view.`, { cause: error });
    }
  }

  for (const [role, pageIndex] of rolePages) {
    await context.request.post(`${appUrl}/api/lc/v1/session/logout`, { data: {} });
    const account = accounts.find((candidate) => candidate.role === role);
    assert.ok(account, `${role} demo account is unavailable`);
    assert.equal((await context.request.post(`${appUrl}/api/lc/v1/auth/login`, { data: account })).status(), 200);
    await selectPage(pageIndex);
    await page.getByTitle("刷新业务画面").click();
    await page.waitForFunction(() => document.querySelector(".stage-status-strip")?.textContent?.includes("角色就绪"));
    assert.ok(!(await page.locator(".stage-status-strip").innerText()).includes("正在检查"));
  }
} finally {
  await context.request.post(`${appUrl}/api/lc/v1/session/logout`, { data: {} }).catch(() => undefined);
  await browser.close();
}
