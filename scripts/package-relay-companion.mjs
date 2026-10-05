import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const relay = resolve(root, "apps/relay");
const output = resolve(root, "apps/relay/release/Showit_Relay_Companion.tar.gz");
await mkdir(dirname(output), { recursive: true });

const archive = spawn("tar", ["-czf", output, "package.json", "src", "public", "Dockerfile", "docker-compose.yml"], { cwd: relay, stdio: "inherit" });
const code = await new Promise((resolveCode) => archive.on("exit", (value) => resolveCode(value ?? 1)));
if (code !== 0) throw new Error(`Companion 打包失败（code ${code}）。`);
console.log(output);
