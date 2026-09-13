import { readFile, writeFile } from "node:fs/promises";
import { dirname, basename, resolve } from "node:path";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const version = value("--version");
const baseUrl = value("--base-url");
const output = value("--output");
const windows = value("--windows");
const linux = value("--linux");
const releaseUrl = value("--release-url");

if (!version || !baseUrl?.startsWith("https://") || !releaseUrl?.startsWith("https://") || !output || !windows || !linux) {
  throw new Error("需要 --version、--base-url、--release-url、--output、--windows 和 --linux 参数。");
}

async function platform(signaturePath) {
  if (!signaturePath.endsWith(".sig")) throw new Error(`签名文件无效：${signaturePath}`);
  const artifact = basename(signaturePath.slice(0, -4));
  return {
    signature: (await readFile(signaturePath, "utf8")).trim(),
    url: `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(artifact)}`
  };
}

const manifest = {
  version: version.replace(/^v/, ""),
  notes: process.env.SHOWIT_RELEASE_NOTES ?? "Showit 稳定版更新。",
  pub_date: new Date().toISOString(),
  releaseUrl,
  platforms: {
    "windows-x86_64": await platform(resolve(windows)),
    "linux-x86_64": await platform(resolve(linux))
  }
};
await writeFile(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Generated updater manifest: ${output}`);
