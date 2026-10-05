import { spawn } from "node:child_process";
import process from "node:process";

const root = process.cwd();
const commands = [
  ["demo", "npm", ["run", "demo:dev"]],
  ["companion", "npm", ["run", "relay:companion"]],
  ["extension", "npm", ["run", "dev"]]
];
const children = commands.map(([name, command, args]) => {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: false, detached: true });
  child.on("exit", (code, signal) => {
    if (code !== 0 && signal === null) console.error(`[${name}] 已退出（code ${code ?? "unknown"}）。`);
  });
  return child;
});

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed && child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    }
  }
  setTimeout(() => process.exit(0), 500);
}

process.once("SIGINT", stopAll);
process.once("SIGTERM", stopAll);
process.once("exit", stopAll);
