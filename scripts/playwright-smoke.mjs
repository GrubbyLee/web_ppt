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
  await assertViewportFit(presenter, "presenter at 1440px");
  assert.equal(await presenter.locator(".page-grid").count(), 0);

  await presenter.getByTitle("打开页面选择网格").click();
  assert.equal(await presenter.locator(".page-grid button").count(), 18);
  await presenter.locator(".page-grid button").nth(1).click();
  await presenter.getByText("目录与五角色地图").first().waitFor({ state: "visible" });

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
} finally {
  await browser.close();
}
