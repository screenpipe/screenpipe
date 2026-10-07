// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Tauri injects its IPC bridge into every page a webview loads, including
// outside websites in the agent browser, login windows, and the main window
// after a link click. Those pages are kept away from the fs, store, http and
// process plugins only because no capability lists a remote origin: a remote
// URL listed there gets every permission in that capability on every window.

type Capability = { identifier?: string; remote?: unknown };

const srcTauri = resolve(process.cwd(), "src-tauri");
const capabilitiesDir = resolve(srcTauri, "capabilities");

// Mirrors tauri-utils `CapabilityFile`: a file holds one capability, a list of
// them, or `{ "capabilities": [...] }`.
function capabilitiesIn(file: string): Capability[] {
  const parsed = JSON.parse(readFileSync(resolve(capabilitiesDir, file), "utf8"));
  if (Array.isArray(parsed)) return parsed;
  return Array.isArray(parsed.capabilities) ? parsed.capabilities : [parsed];
}

function rustSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((dirent) => {
    const path = resolve(directory, dirent.name);
    if (dirent.isDirectory()) return rustSourceFiles(path);
    return dirent.name.endsWith(".rs") ? [path] : [];
  });
}

describe("webview remote IPC", () => {
  it("compiles in only capability files this test reads", () => {
    // build.rs picks the files Tauri loads; they must stay inside the
    // directory checked below. A dynamic pattern would bypass this check.
    const patterns = [
      ...readFileSync(resolve(srcTauri, "build.rs"), "utf8").matchAll(
        /capabilities_path_pattern\(\s*([^)]*)\)/g,
      ),
    ].map((match) => match[1].trim());
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(pattern).toMatch(/^"(?:\.\/)?capabilities\/[^/"]+"$/);
    }
  });

  it("keeps every capability file in a format this test reads", () => {
    const files = readdirSync(capabilitiesDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => !file.endsWith(".json"))).toEqual([]);
  });

  it("grants no capability to remote origins", () => {
    const remote = readdirSync(capabilitiesDir).flatMap((file) =>
      capabilitiesIn(file)
        .filter((capability) => "remote" in capability)
        .map((capability) => `${file}: ${capability.identifier}`),
    );
    expect(remote).toEqual([]);
  });

  it("defines no inline capabilities in any Tauri config", () => {
    const configs = readdirSync(srcTauri).filter((file) => /^tauri\..+\.json$/.test(file));
    expect(configs).toContain("tauri.conf.json");
    for (const file of configs) {
      const config = JSON.parse(readFileSync(resolve(srcTauri, file), "utf8"));
      expect(config.app?.security?.capabilities, file).toBeUndefined();
    }
  });

  it("adds no capability at runtime", () => {
    const callers = rustSourceFiles(resolve(srcTauri, "src")).filter((file) =>
      readFileSync(file, "utf8").includes("add_capability"),
    );
    expect(callers).toEqual([]);
  });
});
