import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hostName = "com.showit.desktop";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function argument(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const extensionId = argument("--extension-id") ?? process.env.SHOWIT_EXTENSION_ID;
const uninstall = args.includes("--uninstall");
const platform = argument("--platform") ?? process.platform;
const defaultHost = platform === "win32"
  ? resolve(root, "apps/desktop/src-tauri/target/release/showit-native-host.exe")
  : resolve(root, "apps/desktop/src-tauri/target/release/showit-native-host");
const hostPath = resolve(argument("--host") ?? process.env.SHOWIT_NATIVE_HOST_PATH ?? defaultHost);

if (!extensionId || !/^[a-p]{32}$/.test(extensionId) || new Set(extensionId).size < 2) {
  throw new Error("请通过 --extension-id 或 SHOWIT_EXTENSION_ID 提供有效的 32 位 Chrome 扩展 ID。");
}
if (!uninstall && !existsSync(hostPath)) throw new Error(`Native Host 不存在：${hostPath}`);

const manifest = JSON.stringify({
  name: hostName,
  description: "Showit Desktop Native Messaging Host",
  path: hostPath,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`]
}, null, 2);

function registerLinux() {
  const home = process.env.HOME ?? homedir();
  const roots = [
    resolve(home, ".config/google-chrome/NativeMessagingHosts"),
    resolve(home, ".config/chromium/NativeMessagingHosts"),
    resolve(home, ".config/microsoft-edge/NativeMessagingHosts")
  ];
  for (const directory of roots) {
    const destination = resolve(directory, `${hostName}.json`);
    if (uninstall) {
      rmSync(destination, { force: true });
      continue;
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(destination, manifest, { mode: 0o600 });
    chmodSync(destination, 0o600);
  }
}

function registerWindows() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("无法确定 LOCALAPPDATA。");
  const directory = resolve(localAppData, "Showit", "NativeMessagingHosts");
  const destination = resolve(directory, `${hostName}.json`);
  const registryKeys = [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${hostName}`,
    `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${hostName}`
  ];
  if (uninstall) {
    for (const key of registryKeys) {
      try {
        execFileSync("reg.exe", ["DELETE", key, "/f"], { stdio: "ignore" });
      } catch {
        // Uninstall remains idempotent when a browser key does not exist.
      }
    }
    rmSync(destination, { force: true });
    return;
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(destination, manifest);
  for (const key of registryKeys) {
    execFileSync("reg.exe", ["ADD", key, "/ve", "/t", "REG_SZ", "/d", destination, "/f"], { stdio: "ignore" });
  }
}

if (platform === "linux") registerLinux();
else if (platform === "win32") registerWindows();
else throw new Error(`暂不支持在 ${platform} 注册 Native Messaging Host。`);

console.log(uninstall ? "Showit Native Messaging Host 已取消注册。" : "Showit Native Messaging Host 已注册。重启浏览器后生效。");
