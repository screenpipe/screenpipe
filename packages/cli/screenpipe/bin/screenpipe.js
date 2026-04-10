#!/usr/bin/env node

const { execFileSync, execSync } = require("child_process");
const { join, dirname } = require("path");
const { existsSync, chmodSync } = require("fs");

const PLATFORMS = {
  "darwin-arm64": "@screenpipe/cli-darwin-arm64",
  "darwin-x64": "@screenpipe/cli-darwin-x64",
  "linux-x64": "@screenpipe/cli-linux-x64",
  "win32-x64": "@screenpipe/cli-win32-x64",
};

const key = `${process.platform}-${process.arch}`;
const pkg = PLATFORMS[key];

if (!pkg) {
  console.error(`screenpipe: unsupported platform ${key}`);
  console.error(`supported: ${Object.keys(PLATFORMS).join(", ")}`);
  process.exit(1);
}

let binPath;
try {
  const pkgPath = require.resolve(`${pkg}/package.json`);
  const ext = process.platform === "win32" ? ".exe" : "";
  binPath = join(dirname(pkgPath), "bin", `screenpipe${ext}`);
} catch {
  console.error(`screenpipe: platform package ${pkg} not installed`);
  console.error(`run: npm install screenpipe   (or: bun install screenpipe)`);
  process.exit(1);
}

if (!existsSync(binPath)) {
  console.error(`screenpipe: binary not found at ${binPath}`);
  console.error(`the platform package may be corrupted. try reinstalling.`);
  process.exit(1);
}

// macOS: remove quarantine attribute (Gatekeeper) and ensure executable
if (process.platform === "darwin") {
  try {
    execSync(`xattr -d com.apple.quarantine "${binPath}" 2>/dev/null || true`);
  } catch {}
  try {
    chmodSync(binPath, 0o755);
  } catch {}
}

// Linux: ensure executable
if (process.platform === "linux") {
  try {
    chmodSync(binPath, 0o755);
  } catch {}
}

try {
  execFileSync(binPath, process.argv.slice(2), { stdio: "inherit" });
} catch (e) {
  if (e.status !== undefined) {
    process.exit(e.status);
  }

  // Helpful error messages for common failures
  const msg = (e.message || "").toLowerCase();
  if (process.platform === "darwin" && msg.includes("eperm")) {
    console.error(`\nscreenpipe: macOS blocked the binary.`);
    console.error(`go to System Settings > Privacy & Security and allow screenpipe.`);
    console.error(`or run: xattr -d com.apple.quarantine "${binPath}"`);
  } else if (process.platform === "linux" && msg.includes("enoent")) {
    console.error(`\nscreenpipe: missing system libraries.`);
    console.error(`try: sudo apt install libasound2-dev ffmpeg  (ubuntu/debian)`);
    console.error(`     sudo dnf install alsa-lib ffmpeg         (fedora)`);
  } else if (process.platform === "win32" && msg.includes("onnxruntime")) {
    console.error(`\nscreenpipe: missing onnxruntime.dll`);
    console.error(`check that it's alongside screenpipe.exe in the package.`);
  }

  process.exit(e.status || 1);
}
