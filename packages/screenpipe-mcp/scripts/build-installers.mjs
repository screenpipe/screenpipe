// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packExtension } from "@anthropic-ai/mcpb/cli";
import { zipSync } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "installers");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const read = (file) => readFileSync(path.join(root, file));
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const icon = readFileSync(path.join(root, "../../apps/screenpipe-app-tauri/src-tauri/icons/512x512.png"));
const license = readFileSync(path.join(root, "../../LICENSE.md"));

// Rebuild instead of shipping a stale dist/. Only explicitly listed files enter
// either archive, never credentials, local config, sources, or node_modules.
execFileSync("bun", ["run", "build"], { cwd: root, stdio: "inherit" });
mkdirSync(output, { recursive: true });
const stage = mkdtempSync(path.join(tmpdir(), "screenpipe-installers-"));
try {
  const manifest = JSON.parse(read("manifest.json"));
  manifest.version = pkg.version;
  manifest.icon = "icon.png";
  const localFiles = {
    "manifest.json": json(manifest),
    "package.json": json({ name: pkg.name, version: pkg.version, license: pkg.license }),
    "dist/index.js": read("dist/index.js"),
    "README.md": read("README.md"),
    "LICENSE.md": license,
    "icon.png": icon,
  };
  for (const [file, bytes] of Object.entries(localFiles)) {
    const target = path.join(stage, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  const localArchive = path.join(output, "screenpipe-local.mcpb");
  if (!await packExtension({ extensionPath: stage, outputPath: localArchive, silent: true })) {
    throw new Error("MCPB validation or packaging failed");
  }

  const portable = JSON.parse(read("plugins/screenpipe-cloud/plugin.json"));
  const mcp = JSON.parse(read("plugins/screenpipe-cloud/mcp.json"));
  const { $schema, extensions, ...identity } = portable;
  const legacyMcp = { mcpServers: Object.fromEntries(Object.entries(mcp.mcpServers)
    .map(([name, config]) => [name, { ...config, type: "http" }])) };
  const cloudFiles = {
    "plugin.json": json(portable),
    "mcp.json": json(mcp),
    ".claude-plugin/plugin.json": json(identity),
    ".codex-plugin/plugin.json": json({ ...identity, mcpServers: "./.mcp.json", ...extensions["com.openai"] }),
    ".mcp.json": json(legacyMcp),
    "assets/icon.png": icon,
    "README.md": read("plugins/screenpipe-cloud/README.md"),
    "LICENSE.md": license,
  };
  // Expose the same directory as the ZIP for local host validation/install.
  const cloudDir = path.join(output, "screenpipe-cloud");
  rmSync(cloudDir, { recursive: true, force: true });
  for (const [file, bytes] of Object.entries(cloudFiles)) {
    const target = path.join(cloudDir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(path.join(output, "screenpipe-cloud.zip"), zipSync(cloudFiles));
  // Portable local bundle for Hermes and OpenClaw; no runtime package download.
  const agentManifest = JSON.parse(read("plugins/screenpipe-agent/plugin.json"));
  agentManifest.version = pkg.version;
  const agentFiles = {
    "plugin.json": json(agentManifest),
    "mcp.json": read("plugins/screenpipe-agent/mcp.json"),
    "dist/index.js": read("dist/index.js"),
    "skills/screenpipe/SKILL.md": read("plugins/screenpipe-agent/skills/screenpipe/SKILL.md"),
    "README.md": read("plugins/screenpipe-agent/README.md"),
    "LICENSE.md": license,
  };
  const agentDir = path.join(output, "screenpipe-agent");
  rmSync(agentDir, { recursive: true, force: true });
  for (const [file, bytes] of Object.entries(agentFiles)) {
    const target = path.join(agentDir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(path.join(output, "screenpipe-agent.zip"), zipSync(agentFiles));
  copyFileSync(path.join(root, "plugins/screenpipe-cloud/SUBMISSION.md"), path.join(output, "SUBMISSION.md"));
  console.log(`Installers written to ${output}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
