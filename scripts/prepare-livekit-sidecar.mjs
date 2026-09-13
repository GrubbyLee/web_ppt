import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const version = "1.13.6";
const targets = {
  "linux-x64": {
    archive: `livekit_${version}_linux_amd64.tar.gz`,
    binary: "livekit-server",
    output: "livekit-server-x86_64-unknown-linux-gnu",
    sha256: "2b61abef2b9ba14b4b8ca38b37de9a37ffc682b9931d5fc03ceca2f0b77d3e33",
    binarySha256: "ca0f0147599b5dab5f564dd96603a53d3c1e4f64ea67371bf8e51b7ae62f0b18"
  },
  "win32-x64": {
    archive: `livekit_${version}_windows_amd64.zip`,
    binary: "livekit-server.exe",
    output: "livekit-server-x86_64-pc-windows-msvc.exe",
    sha256: "9df299b6c6c32f1be88d3d106a9a63f8f921b424b353cc59f57d6b84532a4475",
    binarySha256: "caeb71e5242fedf9eafd16dc6a23d2484a5012d67685e9f4b302e791a7a3e152"
  }
};

const target = targets[`${process.platform}-${process.arch}`];
if (!target) {
  throw new Error(`LiveKit sidecar is only packaged for Linux/Windows x86_64, got ${process.platform}/${process.arch}.`);
}

const outputDir = new URL("../apps/desktop/src-tauri/binaries/", import.meta.url);
const outputPath = new URL(target.output, outputDir);
await mkdir(outputDir, { recursive: true });
try {
  const hash = createHash("sha256").update(await readFile(outputPath)).digest("hex");
  if (hash === target.binarySha256) process.exit(0);
} catch {
  // The pinned archive is downloaded below.
}

const temporary = await mkdtemp(join(tmpdir(), "showit-livekit-"));
const archivePath = join(temporary, target.archive);
try {
  const response = await fetch(`https://github.com/livekit/livekit/releases/download/v${version}/${target.archive}`);
  if (!response.ok) throw new Error(`LiveKit download failed: HTTP ${response.status}`);
  await writeFile(archivePath, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  const hash = createHash("sha256").update(await readFile(archivePath)).digest("hex");
  if (hash !== target.sha256) throw new Error("LiveKit archive SHA-256 verification failed.");
  const extraction = spawnSync("tar", ["-xf", archivePath, "-C", temporary], { encoding: "utf8" });
  if (extraction.status !== 0) throw new Error(`LiveKit extraction failed: ${extraction.stderr || extraction.stdout}`);
  await copyFile(join(temporary, target.binary), outputPath);
  if (process.platform !== "win32") await chmod(outputPath, 0o755);
  const binaryHash = createHash("sha256").update(await readFile(outputPath)).digest("hex");
  if (binaryHash !== target.binarySha256) throw new Error("LiveKit binary SHA-256 verification failed.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
