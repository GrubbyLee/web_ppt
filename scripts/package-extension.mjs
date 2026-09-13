import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "apps/extension/dist");
const version = process.env.npm_package_version ?? "0.1.0";
const output = resolve(root, `apps/extension/release/Showit_Controller_${version}.zip`);
const files = {};

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) files[relative(source, path).replaceAll("\\", "/")] = [new Uint8Array(await readFile(path)), { mtime: new Date("1980-01-01T00:00:00Z") }];
  }
}

await collect(source);
if (!files["manifest.json"] || !files["sidepanel.js"]) throw new Error("扩展构建产物不完整");
const archive = zipSync(files, { level: 9 });
await mkdir(dirname(output), { recursive: true });
await writeFile(output, archive);
const digest = createHash("sha256").update(archive).digest("hex");
await writeFile(`${output}.sha256`, `${digest}  ${output.split(/[\\/]/).at(-1)}\n`, "utf8");
console.log(`${output}\nSHA-256 ${digest}`);
