import { inflateSync, deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

/* ── 最小 PNG 编解码（用于像素级分析；模型看不到图，只能靠算） ───────────── */

function crc32(bytes) {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function decodePng(file) {
  const buf = readFileSync(file);
  let off = 8;
  let w = 0;
  let h = 0;
  let depth = 8;
  let colorType = 6;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
    }
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  if (depth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error(`不支持的 PNG: depth=${depth} type=${colorType}`);
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < h; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 0xff;
      else if (filter === 2) line[i] = (line[i] + b) & 0xff;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    for (let x = 0; x < w; x += 1) {
      const s = x * channels;
      const d = (y * w + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { w, h, pixels: out };
}

function encodePng(w, h, pixels, file) {
  const rows = [];
  for (let y = 0; y < h; y += 1) {
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x += 1) {
      const s = (y * w + x) * 4;
      const d = 1 + x * 4;
      row[d] = pixels[s];
      row[d + 1] = pixels[s + 1];
      row[d + 2] = pixels[s + 2];
      row[d + 3] = pixels[s + 3];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0))
  ]));
}

/** 粗略“墨量”密度图：每个区块里与背景色差异较大的像素占比，用来看视觉重量分布。 */
function densityMap(img, cols = 12, rows = 8) {
  const { w, h, pixels } = img;
  const cellW = Math.floor(w / cols);
  const cellH = Math.floor(h / rows);
  const grid = [];
  for (let ry = 0; ry < rows; ry += 1) {
    const line = [];
    for (let cx = 0; cx < cols; cx += 1) {
      const counts = new Map();
      for (let y = ry * cellH; y < (ry + 1) * cellH; y += 2) {
        for (let x = cx * cellW; x < (cx + 1) * cellW; x += 2) {
          const o = (y * w + x) * 4;
          const key = `${pixels[o] >> 4},${pixels[o + 1] >> 4},${pixels[o + 2] >> 4}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      let bg = 0;
      let total = 0;
      for (const value of counts.values()) {
        total += value;
        if (value > bg) bg = value;
      }
      const ink = total === 0 ? 0 : 1 - bg / total;
      line.push(Math.round(ink * 9));
    }
    grid.push(line);
  }
  return grid;
}

/* ── 页面侧的结构化审计 ─────────────────────────────────────────────── */

const AUDIT = () => {
  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.1) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const parse = (value) => {
    const m = value.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(",").map((p) => Number(p.trim()));
    return { rgb: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 };
  };
  const bgOf = (el) => {
    let node = el;
    while (node && node !== document.documentElement.parentNode) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.5) return c.rgb;
      node = node.parentElement;
    }
    return [255, 255, 255];
  };
  const contrast = (el) => {
    const fg = parse(getComputedStyle(el).color);
    if (!fg) return null;
    const bg = bgOf(el);
    const l1 = lum(fg.rgb);
    const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    return Math.round(ratio * 10) / 10;
  };

  const texts = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
    if (!own) continue;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    texts.push({
      text: own.slice(0, 60),
      size: Math.round(parseFloat(style.fontSize) * 10) / 10,
      weight: style.fontWeight,
      contrast: contrast(el),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width)
    });
  }
  const buttons = [...document.querySelectorAll("button")].filter(visible).map((b) => {
    const r = b.getBoundingClientRect();
    return {
      text: b.textContent.trim().slice(0, 24),
      title: b.getAttribute("title")?.slice(0, 40) ?? "",
      w: Math.round(r.width),
      h: Math.round(r.height),
      contrast: contrast(b),
      y: Math.round(r.y)
    };
  });
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    docHeight: document.documentElement.scrollHeight,
    texts: texts.sort((a, b) => b.size - a.size || a.y - b.y),
    buttons
  };
};

/* ── 真机流程 ───────────────────────────────────────────────────────────
 *
 * 用法：xvfb-run -a node scripts/audit-presenter-ux.mjs
 *
 * 用来回答"演讲者一眼能不能看懂"：把首屏与演示中的控制台分别量出文字层级、
 * 按钮尺寸/对比度，并把业务画面与控制台合成为演讲者真正看到的一屏，算出墨量
 * 密度图。模型看不到图，只能靠这些量化证据判断视觉重量是否压在画面上。
 */────────────────────────────────────────────────────── */

const root = "/home/arabica/codes/showit";
const extensionDir = resolve(root, "apps/extension/.output/chrome-mv3");
const out = "/tmp/audit";
const PANEL_W = 420;
const WIN_W = 1440;
const WIN_H = 900;

const ctx = await chromium.launchPersistentContext("/tmp/audit-profile", {
  headless: false,
  viewport: { width: WIN_W, height: WIN_H },
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, "--no-first-run", "--no-default-browser-check"]
});
const sw = ctx.serviceWorkers().at(0) ?? await ctx.waitForEvent("serviceworker", { timeout: 10_000 });
const id = sw.url().split("/").at(2);

// 1) 第一眼：演讲者打开侧边栏（此时还没有演示）
const panel = await ctx.newPage();
await panel.setViewportSize({ width: PANEL_W, height: WIN_H });
await panel.goto(`chrome-extension://${id}/sidepanel.html`);
await panel.waitForSelector(".panel-library", { timeout: 15_000 });
await panel.waitForTimeout(1200);
const firstGlance = await panel.evaluate(AUDIT);
await panel.screenshot({ path: `${out}-1-first.png` });

// 2) 运行内置示例
await panel.getByTitle("启动演示运行时").click();
await panel.waitForSelector(".panel-page", { timeout: 20_000 });
await panel.waitForTimeout(2500);
const consoleState = await panel.evaluate(AUDIT);
await panel.screenshot({ path: `${out}-2-console.png` });

// 3) 演示画面（真实标签）
const stage = ctx.pages().find((p) => p.url().includes("/stage.html") || p.url().includes("/demo.html"));
await stage?.setViewportSize({ width: WIN_W - PANEL_W, height: WIN_H });
await stage?.waitForTimeout(1200);
await stage?.screenshot({ path: `${out}-3-stage.png` });

// 3b) 走到第 6 页（真实内容页）再合成一次，避免用封面页得出"画面很空"的误判
for (let i = 0; i < 5; i += 1) {
  await panel.locator(".panel-page-nav").getByTitle("下一页").click();
  await panel.waitForTimeout(700);
}
await panel.waitForTimeout(2500);
const consolePage6 = await panel.evaluate(AUDIT);
await panel.screenshot({ path: `${out}-2b-console-p6.png` });
await stage?.waitForTimeout(1500);
await stage?.screenshot({ path: `${out}-3b-stage-p6.png` });
console.log("=== 第 6 页：控制台文档高 ===", consolePage6.docHeight);

// 4) 合成演讲者真正看到的画面：左业务系统 / 右控制台
if (stage) {
  const left = decodePng(`${out}-3b-stage-p6.png`);
  const right = decodePng(`${out}-2b-console-p6.png`);
  const W = left.w + right.w;
  const H = Math.max(left.h, right.h);
  const composite = Buffer.alloc(W * H * 4, 255);
  const blit = (img, x0) => {
    for (let y = 0; y < img.h; y += 1) {
      for (let x = 0; x < img.w; x += 1) {
        const s = (y * img.w + x) * 4;
        const d = (y * W + (x + x0)) * 4;
        composite[d] = img.pixels[s];
        composite[d + 1] = img.pixels[s + 1];
        composite[d + 2] = img.pixels[s + 2];
        composite[d + 3] = 255;
      }
    }
  };
  blit(left, 0);
  blit(right, left.w);
  encodePng(W, H, composite, `${out}-4-composite.png`);
  console.log("=== 第 6 页合成视图（左业务 1020 / 右控制台 420）墨量密度图 (0-9) ===");
  console.log(densityMap({ w: W, h: H, pixels: composite }, 16, 9).map((row) => row.join(" ")).join("\n"));
}

console.log("\n=== 第一眼（无演示，侧边栏）===");
console.log("视口:", JSON.stringify(firstGlance.viewport), "文档高:", firstGlance.docHeight);
console.log("-- 可见文字（按字号降序）--");
for (const t of firstGlance.texts.slice(0, 26)) console.log(`  ${String(t.size).padStart(5)}px w${t.weight} 对比${t.contrast ?? "?"}  ${t.text}`);
console.log("-- 按钮 --");
for (const b of firstGlance.buttons) console.log(`  ${b.w}x${b.h} 对比${b.contrast ?? "?"}  「${b.text}」 title=${b.title}`);

console.log("\n=== 演示中的控制台 ===");
console.log("文档高:", consoleState.docHeight, "（视口高 900，超出即需要滚动）");
console.log("-- 可见文字（按字号降序）--");
for (const t of consoleState.texts.slice(0, 30)) console.log(`  ${String(t.size).padStart(5)}px w${t.weight} 对比${t.contrast ?? "?"}  ${t.text}`);
console.log("-- 按钮 --");
for (const b of consoleState.buttons) console.log(`  ${b.w}x${b.h} y=${b.y} 对比${b.contrast ?? "?"}  「${b.text}」`);
console.log("-- 对比度低于 4.5 的文字 --");
for (const t of consoleState.texts.filter((x) => x.contrast !== null && x.contrast < 4.5)) console.log(`  ${t.contrast}  ${t.text}`);
console.log("-- 点击区高度 < 32px 的按钮 --");
for (const b of consoleState.buttons.filter((x) => x.h < 32)) console.log(`  ${b.w}x${b.h} 「${b.text}」`);

await ctx.close();
