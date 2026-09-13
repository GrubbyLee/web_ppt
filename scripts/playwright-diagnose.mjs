import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = resolve(root, "test-results");
const appUrl = "http://127.0.0.1:4173";
await mkdir(artifacts, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on("console", (message) => logs.push(`[console:${message.type()}] ${message.text()}`));
page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}\n${error.stack ?? ""}`));

await page.goto(`${appUrl}/#/presenter`);
await page.waitForLoadState("networkidle");
await page.screenshot({ path: resolve(artifacts, "diagnose.png"), fullPage: true });
console.log("title:", await page.title());
console.log("body:", (await page.locator("body").innerText()).slice(0, 2000));
console.log(logs.join("\n"));
await browser.close();
