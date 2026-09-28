import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const targets = {
  extension: { directory: resolve(root, "apps/extension/.output/chrome-mv3"), limit: 1200 * 1024 }
};
const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(targets);

async function directorySize(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return directorySize(path);
    return entry.isFile() ? (await stat(path)).size : 0;
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

for (const name of names) {
  const target = targets[name];
  if (!target) throw new Error(`未知构建目标：${name}`);
  const size = await directorySize(target.directory);
  if (size > target.limit) throw new Error(`${name} 构建产物 ${(size / 1024).toFixed(1)} KiB 超出 ${(target.limit / 1024).toFixed(0)} KiB 预算。`);
  console.log(`${name} 构建产物 ${(size / 1024).toFixed(1)} KiB / ${(target.limit / 1024).toFixed(0)} KiB`);
}
