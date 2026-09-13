import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync, strToU8 } from "fflate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function argument(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const version = process.env.npm_package_version ?? "0.1.0";
const source = resolve(argument("--source") ?? resolve(root, "apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release"));
const output = resolve(argument("--output") ?? resolve(root, `apps/desktop/src-tauri/target/release/bundle/portable/Showit_${version}_windows_x64.zip`));
const executable = resolve(source, "showit.exe");
const nativeHost = resolve(source, "showit-native-host.exe");
const livekitServer = resolve(source, "livekit-server.exe");

for (const required of [executable, nativeHost, livekitServer]) {
  if (!existsSync(required)) throw new Error(`便携包缺少构建产物：${required}`);
}

const instructions = `Showit Windows 便携版

直接运行 Showit.exe。默认数据仍保存到当前用户的应用数据目录。

如需把项目和浏览器专用配置保存在便携包目录：
1. 关闭 Showit。
2. 将 portable-data.enabled.example 重命名为 portable-data.enabled。
3. 再次启动 Showit，数据将写入同目录的 data 文件夹。

请勿在 Showit 运行时拔出移动存储设备。升级前请备份 data 文件夹。
`;

const archive = zipSync({
  "Showit/Showit.exe": new Uint8Array(await readFile(executable)),
  "Showit/showit-native-host.exe": new Uint8Array(await readFile(nativeHost)),
  "Showit/livekit-server.exe": new Uint8Array(await readFile(livekitServer)),
  "Showit/EULA.zh-CN.txt": new Uint8Array(await readFile(resolve(root, "docs/legal/EULA.zh-CN.txt"))),
  "Showit/COMMERCIAL-LICENSE.zh-CN.txt": new Uint8Array(await readFile(resolve(root, "docs/legal/COMMERCIAL-LICENSE.zh-CN.txt"))),
  "Showit/THIRD-PARTY-NOTICES.txt": new Uint8Array(await readFile(resolve(root, "docs/legal/THIRD-PARTY-NOTICES.txt"))),
  "Showit/APACHE-2.0.txt": new Uint8Array(await readFile(resolve(root, "docs/legal/APACHE-2.0.txt"))),
  "Showit/README-portable.zh-CN.txt": strToU8(instructions),
  "Showit/showit-portable.enabled": new Uint8Array(),
  "Showit/portable-data.enabled.example": new Uint8Array()
}, { level: 9 });

await mkdir(dirname(output), { recursive: true });
await writeFile(output, archive);
const digest = createHash("sha256").update(archive).digest("hex");
await writeFile(`${output}.sha256`, `${digest}  ${output.split(/[\\/]/).at(-1)}\n`, "utf8");
console.log(`${output}\nSHA-256 ${digest}`);
