import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = resolve(root, "test-results");
const appUrl = "http://127.0.0.1:4173";
await mkdir(artifacts, { recursive: true });

async function assertNoHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  assert.ok(
    dimensions.scrollWidth <= dimensions.clientWidth,
    `${label} horizontally overflows: ${dimensions.scrollWidth}px > ${dimensions.clientWidth}px`
  );
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

try {
  await page.goto(`${appUrl}/#/projects`);
  await page.waitForLoadState("networkidle");
  await page.getByText("本地演示项目").waitFor({ state: "visible" });

  const sampleId = await page.evaluate(() => JSON.parse(localStorage.getItem("showit:library:v1") ?? "[]")[0]?.project?.id);
  assert.equal(typeof sampleId, "string");
  await page.getByTitle("取消项目信任，停止脚本和自动操作运行").first().click();
  await page.getByText(/已取消.*运行信任/).waitFor({ state: "visible" });
  await page.goto(`${appUrl}/#/presenter/${sampleId}`);
  await page.locator(".project-workspace").waitFor({ state: "visible" });
  assert.match(page.url(), /#\/projects$/);

  await page.getByTitle("导出 .showit 文件").first().click();
  await page.getByLabel("项目包密码").fill("short");
  await page.getByLabel("确认密码").fill("short");
  await page.getByRole("button", { name: "加密导出" }).click();
  await page.getByText("加密密码至少需要 8 个字符。").waitFor({ state: "visible" });
  await page.screenshot({ path: resolve(artifacts, "package-password-dialog-1440.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.locator(".ant-modal").waitFor({ state: "hidden" });

  await page.getByTitle("导出 .showit 文件").first().click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "普通导出", exact: true }).click();
  const download = await downloadPromise;
  const packagePath = resolve(artifacts, "trust-review.showit");
  await download.saveAs(packagePath);
  await page.locator('input[type="file"][accept^=".showit"]').setInputFiles(packagePath);
  await page.getByText("检查导入项目", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("业务域名", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "确认信任并导入", exact: true }).click();
  await page.getByText("同 ID 项目已存在，已作为副本导入。").waitFor({ state: "visible" });

  await page.getByTitle("创建演示项目").click();
  await page.getByPlaceholder("例如：客户产品演示").fill("自动化回归项目");
  await page.getByRole("button", { name: "创建并编辑" }).click();
  await page.getByLabel("页面标题").waitFor({ state: "visible" });

  await page.getByLabel("页面标题").fill("自动化项目首屏");
  await page.getByLabel("局域网观众加入方式").selectOption("approval");
  await page.getByLabel("局域网观众容量").selectOption("sfu-20");
  await page.getByLabel("默认浏览器会话").selectOption("dedicated");
  await page.getByTitle("添加页面", { exact: true }).click();
  assert.equal(await page.locator(".editor-page-item").count(), 2);

  const urlInput = page.getByLabel("业务 URL 模板");
  await urlInput.fill("javascript:alert(1)");
  await page.getByText(/URL 模板必须使用 HTTPS/).first().waitFor({ state: "visible" });
  await urlInput.fill("https://example.com/demo");
  await page.waitForFunction(() => (localStorage.getItem("showit:library:v1") ?? "").includes("https://example.com/demo"));

  await page.getByLabel("离线备用类型").selectOption("html");
  await page.getByRole("textbox", { name: "HTML 源码" }).fill("<main><h1>离线演示内容</h1><img src='https://assets.example.invalid/offline.png' alt=''></main><script>document.body.dataset.offlineReady='yes'</script>");
  const markdownEditor = page.getByLabel("Markdown 脚本");
  await markdownEditor.fill("现场脚本");
  await markdownEditor.click();
  await markdownEditor.press("End");
  await page.getByTitle("插入演示步骤区块").click();
  assert.match(await markdownEditor.inputValue(), /## 演示步骤/);
  await markdownEditor.fill(`${await markdownEditor.inputValue()}\n\n${Array.from({ length: 48 }, (_item, index) => `- 演讲补充 ${index + 1}`).join("\n")}`);
  await markdownEditor.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.waitForFunction(() => (document.querySelector(".editor-markdown-preview")?.scrollTop ?? 0) > 0);
  await page.getByTitle("添加结构化步骤").click();
  await page.getByTitle("添加结构化步骤").click();
  await page.getByTitle("添加仅在演示期间使用的敏感变量").click();
  await page.getByLabel("敏感变量名称").fill("runtime_code");
  await page.getByLabel("敏感变量显示名称").fill("运行时验证码");
  await page.getByLabel(/步骤动作$/).first().selectOption("fill");
  await page.getByLabel(/填写定位方式$/).first().selectOption("aria");
  await page.getByLabel(/填写定位值$/).first().fill("客户名称");
  await page.getByLabel(/填写值来源$/).first().selectOption("fixed");
  await page.getByLabel(/固定填写值$/).first().fill("Showit 演示客户");
  await page.getByLabel(/步骤动作$/).nth(1).selectOption("fill");
  await page.getByLabel(/填写定位方式$/).nth(1).selectOption("id");
  await page.getByLabel(/填写定位值$/).nth(1).fill("verification-code");
  await page.getByLabel(/填写值来源$/).nth(1).selectOption("sensitive");
  assert.equal(await page.getByLabel(/填写变量$/).first().inputValue(), "runtime_code");
  await page.getByLabel(/完成条件$/).first().selectOption("text");
  await page.getByLabel(/条件值$/).first().fill("页面已就绪");
  await page.getByLabel(/条件超时$/).first().fill("12");
  await page.getByLabel(/验证后自动继续$/).first().check();
  await page.getByLabel(/风险级别$/).nth(2).selectOption("high");
  assert.equal(await page.getByLabel(/验证后自动继续$/).count(), 2);
  await page.waitForFunction(() => {
    const library = localStorage.getItem("showit:library:v1") ?? "";
    return library.includes("runtime_code") && library.includes("页面已就绪") && library.includes("演示补充 48");
  });
  await page.reload();
  await page.getByLabel("页面标题").waitFor({ state: "visible" });
  assert.equal(await page.getByLabel("局域网观众加入方式").inputValue(), "approval");
  assert.equal(await page.getByLabel("局域网观众容量").inputValue(), "sfu-20");
  assert.equal(await page.getByLabel("默认浏览器会话").inputValue(), "dedicated");
  await page.getByText("新页面 2", { exact: true }).click();
  assert.match(await page.getByLabel("Markdown 脚本").inputValue(), /## 演示步骤/);
  assert.equal(await page.getByLabel(/完成条件$/).first().inputValue(), "text");
  assert.equal(await page.getByLabel(/条件值$/).first().inputValue(), "页面已就绪");
  assert.equal(await page.getByLabel(/条件超时$/).first().inputValue(), "12");
  assert.equal(await page.getByLabel(/验证后自动继续$/).first().isChecked(), true);
  assert.equal(await page.getByLabel(/风险级别$/).nth(2).inputValue(), "high");
  assert.equal(await page.getByLabel(/填写值来源$/).nth(1).inputValue(), "sensitive");
  assert.equal(await page.getByLabel(/填写变量$/).first().inputValue(), "runtime_code");

  await page.getByTitle("校验并发布版本快照").click();
  await page.getByText("版本 v1 已发布。").waitFor({ state: "visible" });
  assert.equal(await page.locator(".editor-version-list").getByText("v1").count(), 1);

  await assertNoHorizontalOverflow(page, "project editor at 1440px");
  await page.screenshot({ path: resolve(artifacts, "project-editor-1440.png"), fullPage: true });
  await page.getByTitle("保存并创建固定的演示启动快照").click();
  await page.getByText("项目需要信任", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "确认信任并运行", exact: true }).click();
  await page.waitForLoadState("networkidle");
  await page.getByText("自动化回归项目").first().waitFor({ state: "visible" });
  assert.match(page.url(), /#\/presenter\//);
  await page.getByText("输入本次演示的敏感变量", { exact: true }).waitFor({ state: "visible" });
  await page.locator(".runtime-secret-form input").fill("session-only-secret");
  await page.getByRole("button", { name: "开始演示", exact: true }).click();
  await page.getByText("输入本次演示的敏感变量", { exact: true }).waitFor({ state: "hidden" });
  assert.ok(!(await page.evaluate(() => Object.keys(localStorage).map((key) => localStorage.getItem(key)).join("\n"))).includes("session-only-secret"));
  const audienceUrl = await page.locator(".audience-link code").innerText();
  const audience = await context.newPage();
  await audience.goto(audienceUrl);
  await audience.locator(".audience-window").waitFor({ state: "visible" });
  await page.getByTitle("从第一页开始排练").click();
  await page.waitForTimeout(100);
  await page.getByTitle("下个页面").click();
  await page.waitForTimeout(100);
  await page.locator(".steps-list > button").first().click();
  await page.locator(".steps-list > button").nth(1).click();
  await page.locator(".steps-list > button").nth(2).click();
  await page.locator(".high-risk-confirm").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "确认完成", exact: true }).click();
  await page.locator(".high-risk-confirm").waitFor({ state: "hidden" });
  await page.getByTitle("框选仅观众可见的隐私遮罩").click();
  const annotationBox = await page.locator(".business-frame-wrap .annotation-layer").boundingBox();
  assert.ok(annotationBox);
  await page.mouse.move(annotationBox.x + 80, annotationBox.y + 90);
  await page.mouse.down();
  await page.mouse.move(annotationBox.x + 230, annotationBox.y + 180);
  await page.mouse.up();
  await page.locator(".privacy-mask-layer--preview .privacy-mask").waitFor({ state: "visible" });
  await audience.locator(".privacy-mask").waitFor({ state: "visible" });
  await page.getByTitle("切换当前页离线备用内容").click();
  await page.locator(".business-frame-wrap > .offline-fallback").waitFor({ state: "visible" });
  await page.locator(".business-frame-wrap > .offline-fallback iframe").contentFrame().locator("body[data-offline-ready='yes']").waitFor({ state: "visible" });
  await page.getByText("允许离线备用访问网络", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("https://assets.example.invalid", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "允许本次演示", exact: true }).click();
  await page.getByText("允许离线备用访问网络", { exact: true }).waitFor({ state: "hidden" });
  await page.waitForTimeout(1_000);
  const persistedAllowedOrigins = await page.evaluate(() => {
    const library = JSON.parse(localStorage.getItem("showit:library:v1") ?? "[]");
    const workspace = library.find((item) => item?.project?.name === "自动化回归项目");
    const targetPage = workspace?.project?.pages?.find((item) => item?.title === "新页面 2");
    return targetPage?.offline?.allowedNetworkOrigins ?? [];
  });
  assert.deepEqual(persistedAllowedOrigins, []);
  await audience.locator(".offline-fallback").waitFor({ state: "visible" });
  const offlineFrame = audience.locator(".offline-fallback iframe");
  assert.equal(await offlineFrame.getAttribute("sandbox"), "");
  assert.match(await offlineFrame.getAttribute("srcdoc") ?? "", /connect-src 'none'/);
  assert.match(await offlineFrame.getAttribute("srcdoc") ?? "", /script-src 'none'/);
  assert.equal(await offlineFrame.contentFrame().locator("body").getAttribute("data-offline-ready"), null);
  await audience.screenshot({ path: resolve(artifacts, "audience-offline-1440.png"), fullPage: true });
  await page.getByTitle("结束并保存排练记录").click();
  await page.getByTitle("从第一页开始排练").waitFor({ state: "visible" });
  await page.getByTitle("打开设置").click();
  await page.locator(".rehearsal-list").waitFor({ state: "visible" });
  await page.getByText("导出包含已脱敏的运行时与桌面本机服务诊断，不包含截图、视频和业务内容。").waitFor({ state: "visible" });

  await page.setViewportSize({ width: 1024, height: 768 });
  await assertNoHorizontalOverflow(page, "presenter at 1024px");

  await page.keyboard.press("Escape");
  await page.locator(".ant-drawer").waitFor({ state: "hidden" });
  await page.getByTitle("返回项目库").click();
  await audience.locator(".audience-cover--ended").waitFor({ state: "visible" });
  await page.locator(".project-workspace").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some((key) => key.startsWith("showit:presentation-launch:v1:"))), false);

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 375, height: 812 });
  await mobile.goto(`${appUrl}/#/projects`);
  await mobile.waitForLoadState("networkidle");
  await mobile.locator(".project-workspace").waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(mobile, "project workspace at 375px");
  await mobile.screenshot({ path: resolve(artifacts, "project-workspace-375.png"), fullPage: true });
} finally {
  await browser.close();
}
