import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Showit icon set.
 *
 * The mark is the product's own layout, drawn as a presentation slide:
 *   · a slide (the picture the audience sees)
 *   · a teal column on its right (the side panel console)
 *   · a laser dot (the annotation tool)
 * so the icon reads as "left = business system, right = console".
 *
 * Drawing is done on a 4× supersampled grid with hard-edged shapes and then
 * box-filtered down, which gives clean anti-aliasing without a rasteriser.
 */

const sizes = process.env.SHOWIT_ICON_SIZES
  ? process.env.SHOWIT_ICON_SIZES.split(",").map((value) => Number(value.trim()))
  : [16, 32, 48, 128];
const outDir = resolve(process.argv[2] ?? "apps/extension/public/icons");
const SS = 4;

const PALETTE = {
  slateTop: [27, 38, 52],
  slateBottom: [12, 16, 22],
  paper: [245, 248, 251],
  teal: [55, 208, 186],
  ink: [38, 49, 61],
  muted: [167, 182, 196],
  laser: [255, 95, 109]
};

function crc32(bytes) {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// ---- shape tests (all coordinates are fractions of the icon) ---------------

function roundedRect(left, top, right, bottom, radius) {
  return (x, y) => {
    if (x < left || x >= right || y < top || y >= bottom) return false;
    const r = Math.min(radius, (right - left) / 2, (bottom - top) / 2);
    const cx = x < left + r ? left + r : x > right - r ? right - r : x;
    const cy = y < top + r ? top + r : y > bottom - r ? bottom - r : y;
    if (cx === x || cy === y) return true;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };
}

function circle(cx, cy, radius) {
  return (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };
}

function verticalGradient(from, to) {
  return (x, y) => {
    const t = Math.max(0, Math.min(1, y));
    return [
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
      from[2] + (to[2] - from[2]) * t
    ];
  };
}

function encodeIcon(size) {
  const n = size * SS;
  // Premultiplied RGBA accumulator over the supersampled grid.
  const acc = new Float64Array(n * n * 4);

  const shapes = [
    // Stage backdrop: the presenter window.
    { test: roundedRect(0, 0, 1, 1, 0.24), paint: verticalGradient(PALETTE.slateTop, PALETTE.slateBottom) },
    // The slide itself.
    { test: roundedRect(0.13, 0.15, 0.87, 0.85, 0.075), paint: () => PALETTE.paper },
    // Title + body lines: the business content on the slide.
    { test: roundedRect(0.205, 0.285, 0.575, 0.355, 0.022), paint: () => PALETTE.ink },
    { test: roundedRect(0.205, 0.44, 0.615, 0.487, 0.018), paint: () => PALETTE.muted },
    { test: roundedRect(0.205, 0.53, 0.5, 0.577, 0.018), paint: () => PALETTE.muted },
    // Right-hand column: the side panel console.
    { test: roundedRect(0.685, 0.205, 0.815, 0.795, 0.03), paint: () => PALETTE.teal }
  ];
  // The laser dot is a 16px liability — keep the small sizes clean.
  if (size >= 32) shapes.push({ test: circle(0.4, 0.7, 0.055), paint: () => PALETTE.laser });

  for (const shape of shapes) {
    for (let py = 0; py < n; py += 1) {
      const y = (py + 0.5) / n;
      for (let px = 0; px < n; px += 1) {
        const x = (px + 0.5) / n;
        if (!shape.test(x, y)) continue;
        const [r, g, b] = shape.paint(x, y);
        const offset = (py * n + px) * 4;
        // Premultiplied with coverage 1 (shapes are opaque).
        acc[offset] = r;
        acc[offset + 1] = g;
        acc[offset + 2] = b;
        acc[offset + 3] = 1;
      }
    }
  }

  // Box-filter down and un-premultiply.
  const rows = [];
  const samples = SS * SS;
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const offset = ((y * SS + sy) * n + (x * SS + sx)) * 4;
          r += acc[offset];
          g += acc[offset + 1];
          b += acc[offset + 2];
          a += acc[offset + 3];
        }
      }
      const coverage = a / samples; // 0..1
      const offset = 1 + x * 4;
      if (coverage <= 0.0005) {
        row[offset] = 0;
        row[offset + 1] = 0;
        row[offset + 2] = 0;
        row[offset + 3] = 0;
        continue;
      }
      // Un-premultiply the box-filtered colour.
      row[offset] = Math.max(0, Math.min(255, Math.round(r / samples / coverage)));
      row[offset + 1] = Math.max(0, Math.min(255, Math.round(g / samples / coverage)));
      row[offset + 2] = Math.max(0, Math.min(255, Math.round(b / samples / coverage)));
      row[offset + 3] = Math.round(coverage * 255);
    }
    rows.push(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of sizes) {
  const target = join(outDir, `icon-${size}.png`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, encodeIcon(size));
  console.log(`wrote ${target}`);
}
