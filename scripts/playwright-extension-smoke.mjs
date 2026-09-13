import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = resolve(root, "apps/extension/dist");
const artifacts = resolve(root, "test-results");
const profile = await mkdtemp(join(tmpdir(), "showit-extension-"));
await mkdir(artifacts, { recursive: true });
const fixtureServer = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
    <html lang="zh-CN">
      <head><title>Showit content script fixture</title></head>
      <body>
        <label>客户名称 <input id="customer-name" aria-label="客户名称"></label>
        <label>辅助填写 <input id="assist-name" aria-label="辅助填写" value="保留原值"></label>
        <label>登录密码 <input id="login-password" type="password" autocomplete="current-password"></label>
        <script>
          window.__fixtureEvents = [];
          for (const type of ["input", "change"]) {
            document.getElementById("customer-name").addEventListener(type, () => window.__fixtureEvents.push(type));
          }
        </script>
      </body>
    </html>`);
});
await new Promise((resolveListen, rejectListen) => {
  fixtureServer.once("error", rejectListen);
  fixtureServer.listen(0, "127.0.0.1", resolveListen);
});
const fixtureAddress = fixtureServer.address();
assert.ok(fixtureAddress && typeof fixtureAddress !== "string");
const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/business?token=must-not-leak`;

let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
  const extensionId = new URL(worker.url()).host;
  assert.match(extensionId, /^[a-p]{32}$/);

  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background?.service_worker, "background.js");
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  assert.equal(manifest.content_scripts, undefined);

  const registered = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  assert.deepEqual(registered, []);

  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 800 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByText("Showit", { exact: true }).waitFor({ state: "visible" });
  await panel.locator("#origin").waitFor({ state: "visible" });
  await panel.locator("#capture").waitFor({ state: "visible" });
  await panel.locator("#stop-capture").waitFor({ state: "visible" });
  await panel.locator("#open-showit").waitFor({ state: "visible" });
  const dimensions = await panel.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scrollWidth <= dimensions.clientWidth, `Side Panel horizontally overflows: ${dimensions.scrollWidth}px > ${dimensions.clientWidth}px`);
  await panel.screenshot({ path: resolve(artifacts, "extension-sidepanel.png"), fullPage: true });

  const businessPage = await context.newPage();
  await businessPage.addInitScript(() => {
    globalThis.__showitRuntimeMessages = [];
    globalThis.__showitMessageListener = null;
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: {
          sendMessage(message) {
            globalThis.__showitRuntimeMessages.push(message);
            return Promise.resolve();
          },
          onMessage: {
            addListener(listener) {
              globalThis.__showitMessageListener = listener;
            }
          }
        }
      }
    });
    globalThis.__sendShowitMessage = (message) => new Promise((resolveMessage, rejectMessage) => {
      const listener = globalThis.__showitMessageListener;
      if (typeof listener !== "function") {
        rejectMessage(new Error("Showit content script listener is not registered"));
        return;
      }
      let answered = false;
      const asyncResponse = listener(message, {}, (response) => {
        answered = true;
        resolveMessage(response);
      });
      if (asyncResponse !== true && !answered) resolveMessage(undefined);
    });
  });
  await businessPage.goto(fixtureUrl);
  await businessPage.addScriptTag({ path: resolve(extensionPath, "content-script.js") });
  await businessPage.waitForFunction(() => typeof globalThis.__showitMessageListener === "function");

  const probe = await businessPage.evaluate(() => globalThis.__sendShowitMessage({ type: "showit-probe" }));
  assert.equal(probe.privacyRisk, "password");
  assert.equal(probe.hasPasswordField, true);

  const start = await businessPage.evaluate(() => globalThis.__sendShowitMessage({ type: "showit-recorder-start", recordingId: "recording-smoke" }));
  assert.equal(start.ok, true);
  const parsedFixtureUrl = new URL(fixtureUrl);
  assert.equal(start.url, `${parsedFixtureUrl.origin}${parsedFixtureUrl.pathname}`);
  await businessPage.locator("#customer-name").fill("ordinary-value-must-not-persist");
  await businessPage.locator("#login-password").fill("password-value-must-not-persist");
  await businessPage.locator("body").click({ position: { x: 1, y: 1 } });
  await businessPage.evaluate(() => globalThis.__sendShowitMessage({ type: "showit-recorder-stop" }));

  const recordedMessages = await businessPage.evaluate(() => globalThis.__showitRuntimeMessages.filter((message) => message.type === "showit-recorded-action"));
  assert.ok(recordedMessages.some((message) => message.action.type === "fill" && message.action.locator.value === "customer-name" && message.action.input.value === ""));
  const serializedMessages = JSON.stringify(recordedMessages);
  assert.equal(serializedMessages.includes("ordinary-value-must-not-persist"), false);
  assert.equal(serializedMessages.includes("password-value-must-not-persist"), false);
  assert.equal(serializedMessages.includes("login-password"), false);

  await businessPage.locator("#customer-name").fill("");
  const autoResult = await businessPage.evaluate(() => globalThis.__sendShowitMessage({
    type: "showit-execute-action",
    execution: "auto",
    action: { type: "fill", locator: { strategy: "id", value: "customer-name" }, value: "Showit 自动填写" }
  }));
  assert.deepEqual(autoResult, { ok: true, performed: "fill" });
  assert.equal(await businessPage.locator("#customer-name").inputValue(), "Showit 自动填写");
  assert.deepEqual(await businessPage.evaluate(() => globalThis.__fixtureEvents.slice(-2)), ["input", "change"]);

  const assistResult = await businessPage.evaluate(() => globalThis.__sendShowitMessage({
    type: "showit-execute-action",
    execution: "assist",
    action: { type: "fill", locator: { strategy: "id", value: "assist-name" }, value: "不应自动写入" }
  }));
  assert.deepEqual(assistResult, { ok: true, performed: "focus" });
  assert.equal(await businessPage.locator("#assist-name").inputValue(), "保留原值");
  assert.equal(await businessPage.evaluate(() => document.activeElement?.id), "assist-name");
} finally {
  await context?.close();
  await new Promise((resolveClose) => fixtureServer.close(resolveClose));
  await rm(profile, { recursive: true, force: true });
}
