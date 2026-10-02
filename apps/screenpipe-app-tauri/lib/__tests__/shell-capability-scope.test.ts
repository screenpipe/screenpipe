// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// The webview is the least trusted part of the app: anything that renders
// untrusted content there can call `plugin:shell|execute` or `|spawn`
// directly. These tests pin the shell scope so those calls can only run the
// exact launches the UI needs, never an arbitrary command.

type ScopeArg = string | { validator: string; raw?: boolean };
type ScopeEntry = { name: string; cmd: string; args: true | ScopeArg[]; sidecar: boolean };

const capabilitiesDir = resolve(process.cwd(), "src-tauri/capabilities");
const scopedShellPermissions = new Set(["shell:allow-execute", "shell:allow-spawn"]);

function shellEntries(): ScopeEntry[] {
  return readdirSync(capabilitiesDir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      const capability = JSON.parse(readFileSync(resolve(capabilitiesDir, file), "utf8"));
      return (capability.permissions as unknown[]).flatMap((permission) =>
        typeof permission === "object" &&
        permission !== null &&
        scopedShellPermissions.has((permission as { identifier?: string }).identifier ?? "")
          ? ((permission as { allow: ScopeEntry[] }).allow ?? [])
          : [],
      );
    });
}

function entry(name: string): ScopeEntry {
  const found = shellEntries().find((e) => e.name === name);
  if (!found) throw new Error(`no shell scope entry named ${name}`);
  return found;
}

// Mirrors tauri-plugin-shell 2.x `Scope::prepare`: the caller must supply one
// value per scoped arg, validators are anchored as `^{validator}$`, and fixed
// args are always taken from the scope.
function allows(name: string, args: string[]): boolean {
  const scoped = entry(name).args;
  if (scoped === true) return true;
  return scoped.every((arg, i) => {
    if (typeof arg === "string") return true;
    const value = args[i];
    if (value === undefined) return false;
    const pattern = arg.raw ? arg.validator : `^${arg.validator}$`;
    return new RegExp(pattern).test(value);
  });
}

function frontendSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((dirent) => {
    const path = resolve(directory, dirent.name);
    if (dirent.isDirectory()) {
      return dirent.name === "__tests__" || dirent.name === "node_modules"
        ? []
        : frontendSourceFiles(path);
    }
    if (!/\.(?:ts|tsx)$/.test(dirent.name)) return [];
    if (/\.(?:spec|test)\./.test(dirent.name)) return [];
    return [path];
  });
}

describe("webview shell scope", () => {
  it("grants no shell interpreter", () => {
    const interpreters = ["sh", "bash", "zsh", "cmd", "powershell", "pwsh", "osascript"];
    const granted = shellEntries().filter((e) => interpreters.includes(e.cmd));
    expect(granted.map((e) => e.name)).toEqual([]);
  });

  it("grants no system command with unrestricted args", () => {
    const unrestricted = shellEntries().filter((e) => !e.sidecar && e.args === true);
    expect(unrestricted.map((e) => e.name)).toEqual([]);
  });

  it("pins system launchers so a caller cannot replace them through PATH", () => {
    const launchers = shellEntries().filter((e) => !e.sidecar);
    expect(launchers.length).toBeGreaterThan(0);
    for (const launcher of launchers) {
      expect(launcher.cmd, launcher.name).toBe("/usr/bin/open");
    }
  });

  it("has a scope entry for every Command.create call in the frontend", () => {
    const names = new Set(shellEntries().map((e) => e.name));
    const calls = ["app", "components", "lib"]
      .flatMap((dir) => frontendSourceFiles(resolve(process.cwd(), dir)))
      .flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/Command\.create\(\s*([^,)]+)/g)].map(
          (match) => ({ file, name: match[1].trim() }),
        ),
      );

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // A dynamic name would bypass this check.
      expect(call.name, call.file).toMatch(/^"[^"]+"$/);
      expect(names.has(call.name.slice(1, -1)), `${call.file}: ${call.name}`).toBe(true);
    }
  });

  it("reveals only absolute paths in Finder", () => {
    expect(allows("open-reveal", ["-R", "/Users/me/.claude.json"])).toBe(true);
    expect(allows("open-reveal", ["-R", "-a"])).toBe(false);
    expect(allows("open-reveal", ["-R", "relative/path"])).toBe(false);
  });

  it("launches only the named AI apps", () => {
    for (const app of ["Claude", "Cursor", "Codex"]) {
      expect(allows("open-app", ["-a", app]), app).toBe(true);
    }
    expect(allows("open-app", ["-a", "Terminal"])).toBe(false);
    // Guards the alternation against `^Claude|Cursor|Codex$` precedence.
    expect(allows("open-app", ["-a", "ClaudeTerminal"])).toBe(false);
    expect(allows("open-app", ["-a", "Terminal Codex"])).toBe(false);
  });

  it("opens only Codex automation deep links in Codex", () => {
    expect(allows("open-codex-url", ["-b", "com.openai.codex", "codex://automations"])).toBe(true);
    expect(allows("open-codex-url", ["-b", "com.openai.codex", "codex://automations?id=1"])).toBe(true);
    expect(allows("open-codex-url", ["-b", "com.openai.codex", "codex://threads/new?prompt=x"])).toBe(false);
    expect(allows("open-codex-url", ["-b", "com.openai.codex", "/tmp/payload"])).toBe(false);
  });

  it("opens the Full Disk Access pane with fixed args only", () => {
    expect(entry("open-full-disk-access").args).toEqual([
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    ]);
  });
});
