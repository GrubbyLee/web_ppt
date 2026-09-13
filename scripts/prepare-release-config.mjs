import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = resolve(root, "apps/desktop/src-tauri/target/release");
const output = resolve(releaseDirectory, "tauri.release.conf.json");
const hooks = resolve(releaseDirectory, "showit-nsis-hooks.nsh");
const endpoint = process.env.SHOWIT_UPDATER_ENDPOINT
  ?? (process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/latest/download/latest.json` : "");
const pubkey = process.env.SHOWIT_UPDATER_PUBKEY ?? "";
const extensionIds = [...new Set((process.env.SHOWIT_EXTENSION_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean))];

if (!endpoint.startsWith("https://")) throw new Error("SHOWIT_UPDATER_ENDPOINT 必须是 HTTPS 地址。");
if (!pubkey) throw new Error("缺少 SHOWIT_UPDATER_PUBKEY。");
if (extensionIds.length === 0 || extensionIds.some((id) => !/^[a-p]{32}$/.test(id))) {
  throw new Error("SHOWIT_EXTENSION_IDS 必须是一个或多个逗号分隔的 32 位 Chrome 扩展 ID。");
}

const nativeHostManifest = "$LOCALAPPDATA\\Showit\\NativeMessagingHosts\\com.showit.desktop.json";
const origins = extensionIds.map((id) => `chrome-extension://${id}/`).join(", ");
const hookSource = `!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$LOCALAPPDATA\\Showit\\NativeMessagingHosts"
  FileOpen $0 "${nativeHostManifest}" w
  FileWrite $0 "{$\\r$\\n"
  FileWrite $0 "  $\\"name$\\": $\\"com.showit.desktop$\\",$\\r$\\n"
  FileWrite $0 "  $\\"description$\\": $\\"Showit Desktop Native Messaging Host$\\",$\\r$\\n"
  FileWrite $0 "  $\\"path$\\": $\\"$INSTDIR\\\\showit-native-host.exe$\\",$\\r$\\n"
  FileWrite $0 "  $\\"type$\\": $\\"stdio$\\",$\\r$\\n"
  FileWrite $0 "  $\\"allowed_origins$\\": [${origins.split(", ").map((origin) => `$\\"${origin}$\\"`).join(", ")}]$\\r$\\n"
  FileWrite $0 "}$\\r$\\n"
  FileClose $0
  WriteRegStr HKCU "Software\\Google\\Chrome\\NativeMessagingHosts\\com.showit.desktop" "" "${nativeHostManifest}"
  WriteRegStr HKCU "Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.showit.desktop" "" "${nativeHostManifest}"
  WriteRegStr HKCU "Software\\Chromium\\NativeMessagingHosts\\com.showit.desktop" "" "${nativeHostManifest}"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\\Google\\Chrome\\NativeMessagingHosts\\com.showit.desktop"
  DeleteRegKey HKCU "Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.showit.desktop"
  DeleteRegKey HKCU "Software\\Chromium\\NativeMessagingHosts\\com.showit.desktop"
  Delete "${nativeHostManifest}"
!macroend
`;

await mkdir(releaseDirectory, { recursive: true });
await writeFile(hooks, hookSource, "utf8");
await writeFile(output, JSON.stringify({
  bundle: {
    createUpdaterArtifacts: true,
    windows: { nsis: { installMode: "currentUser", installerHooks: hooks } }
  },
  plugins: {
    updater: {
      endpoints: [endpoint],
      pubkey,
      windows: { installMode: "passive" }
    }
  }
}, null, 2), "utf8");
console.log(`Prepared signed release config: ${output}`);
