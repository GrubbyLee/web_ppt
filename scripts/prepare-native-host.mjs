import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = resolve(root, "apps/desktop/src-tauri");
const hostLine = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
  .split("\n")
  .find((line) => line.startsWith("host: "));
if (!hostLine) throw new Error("无法确定 Rust target triple");

const target = hostLine.slice("host: ".length).trim();
const extension = process.platform === "win32" ? ".exe" : "";
const source = resolve(tauriRoot, "target/release", `showit-native-host${extension}`);
const destinationDirectory = resolve(tauriRoot, "binaries");
const destination = resolve(destinationDirectory, `showit-native-host-${target}${extension}`);

mkdirSync(destinationDirectory, { recursive: true });
if (existsSync(source)) copyFileSync(source, destination);
else writeFileSync(destination, "");

execFileSync("cargo", ["build", "--release", "--manifest-path", resolve(tauriRoot, "Cargo.toml"), "--bin", "showit-native-host"], {
  cwd: root,
  stdio: "inherit"
});

copyFileSync(source, destination);
if (process.platform !== "win32") chmodSync(destination, 0o755);
console.log(`Native Messaging Host prepared: ${destination}`);
