import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const sizes = [16, 32, 48, 128];
const outDir = resolve(process.argv[2] ?? "apps/extension/public/icons");
mkdirSync(outDir, { recursive: true });

function crc32(bytes) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
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

function encodeIcon(size) {
  const teal = [55, 208, 186];
  const dark = [17, 19, 24];
  const light = [23, 37, 51];
  const rows = [];
  const inner = Math.round(size * 0.18);
  const outer = size - inner;
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      const onStage = x >= inner && x < outer && y >= inner && y < outer;
      const accent = x >= inner && x < outer && y >= Math.round(size * 0.55);
      const color = onStage ? (accent ? teal : light) : dark;
      const offset = 1 + x * 3;
      row[offset] = color[0];
      row[offset + 1] = color[1];
      row[offset + 2] = color[2];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0))
  ]);
  return png;
}

for (const size of sizes) {
  const target = join(outDir, `icon-${size}.png`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, encodeIcon(size));
  console.log(`wrote ${target}`);
}
