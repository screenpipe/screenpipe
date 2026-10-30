// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { capture, prepareEnterprise, verify } from "./shared-desktop-build";
import { mergeConfig } from "../../apps/screenpipe-app-tauri/scripts/native-build-queue";

const roots: string[] = [];
const sha = "1".repeat(40);
const version = "2.7.124";
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(target: string) {
  const root = mkdtempSync(join(tmpdir(), "shared-desktop-")); roots.push(root);
  const app = join(root, "app");
  const native = join(app, "src-tauri"); mkdirSync(native, { recursive: true });
  const source = resolve(import.meta.dir, "../../apps/screenpipe-app-tauri/src-tauri");
  for (const name of ["Cargo.toml", "tauri.enterprise.conf.json", "tauri.enterprise-persistent.conf.json", "tauri.windows.conf.json", "tauri.linux.conf.json"]) {
    if (existsSync(join(source, name))) cpSync(join(source, name), join(native, name));
  }
  const release = join(native, "target", target, "release"); mkdirSync(release, { recursive: true });
  const payload = join(root, "payload");
  return { root, app, native, release, payload };
}

for (const target of ["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]) {
  test(`${target}: bundle preparation preserves the shared executable and Enterprise resources`, () => {
    const f = fixture(target);
    const binary = Buffer.from("exact compiled executable bytes\x00\x01\x02");
    writeFileSync(join(f.release, `screenpipe-app${target.includes("windows") ? ".exe" : ""}`), binary);
    writeFileSync(join(f.release, `screenpipe${target.includes("windows") ? ".exe" : ""}`), "stale binary from a previous configuration");
    capture(f.app, target, sha, version, f.payload);
    prepareEnterprise(f.app, f.payload, target, sha, version);
    const output = target.includes("windows") ? "screenpipe-app.exe" : "screenpipe-enterprise";
    expect(readFileSync(join(f.release, output))).toEqual(binary);
    const identity = JSON.parse(readFileSync(join(f.native, "screenpipe-package.json"), "utf8"));
    expect(identity.identifier).toBe("screenpi.pe.enterprise");
    expect(identity.updater.endpoints[0]).toContain("/app-update/enterprise/");
    expect(identity.deep_link.desktop.schemes).toEqual(["screenpipe-enterprise"]);
    const overlay = JSON.parse(readFileSync(join(f.native, "shared-build-bundle.conf.json"), "utf8"));
    if (target.includes("windows")) {
      expect(overlay.bundle.resources["ffmpeg\\bin\\ffmpeg.exe"]).toBe("./");
      expect(overlay.bundle.resources["screenpipe-package.json"]).toBe("screenpipe-package.json");
      const persistence = JSON.parse(readFileSync(join(f.native, "tauri.enterprise-persistent.conf.json"), "utf8"));
      const effective = mergeConfig(persistence, overlay) as typeof persistence;
      expect(effective.bundle.resources["screenpipe-package.json"]).toBe("screenpipe-package.json");
      expect(effective.bundle.resources["target\\x86_64-pc-windows-msvc\\release\\screenpipe-persistence-supervisor.exe"]).toBe("./");
      expect(effective.bundle.windows.nsis.installMode).toBe("perMachine");
    } else {
      expect(overlay.bundle.resources).toContain("screenpipe-package.json");
    }
    expect(() => verify(f.payload, target, "2".repeat(40), version)).toThrow("mismatch");
    expect(() => verify(f.payload, target, sha, "2.7.123")).toThrow("mismatch");
    const raw = `screenpipe-app${target.includes("windows") ? ".exe" : ""}`;
    writeFileSync(join(f.payload, raw), "corrupted transfer");
    expect(() => prepareEnterprise(f.app, f.payload, target, sha, version)).toThrow("checksum");
  });
}

test("macOS reuses all compiled code/resources while changing bundle identity and callback registration", () => {
  const target = "aarch64-apple-darwin";
  const f = fixture(target);
  const standard = join(f.release, "bundle/macos/screenpipe.app/Contents");
  mkdirSync(join(standard, "MacOS"), { recursive: true });
  mkdirSync(join(standard, "Resources"), { recursive: true });
  writeFileSync(join(standard, "MacOS/screenpipe-app"), "shared Mach-O payload");
  writeFileSync(join(standard, "Resources/compiled.metallib"), "shared native resource");
  writeFileSync(join(standard, "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>screenpi.pe</string><key>NSMicrophoneUsageDescription</key><string>preserve permission usage text</string></dict></plist>`);
  capture(f.app, target, sha, version, f.payload);
  const enterprise = prepareEnterprise(f.app, f.payload, target, sha, version);
  expect(existsSync(join(f.release, "bundle/macos/screenpipe.app"))).toBe(false);
  expect(readFileSync(join(enterprise, "Contents/MacOS/screenpipe-app"), "utf8")).toBe("shared Mach-O payload");
  expect(readFileSync(join(enterprise, "Contents/Resources/compiled.metallib"), "utf8")).toBe("shared native resource");
  const result = spawnSync("python3", ["-c", "import json,plistlib,sys;print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))", join(enterprise, "Contents/Info.plist")], { encoding: "utf8" });
  expect(result.status).toBe(0);
  const plist = JSON.parse(result.stdout);
  expect(plist.CFBundleIdentifier).toBe("screenpi.pe.enterprise");
  expect(plist.CFBundleURLTypes[0].CFBundleURLSchemes).toEqual(["screenpipe-enterprise"]);
  expect(plist.NSMicrophoneUsageDescription).toBe("preserve permission usage text");
});

test("missing shared build is an actionable failure, never an application compilation fallback", () => {
  const f = fixture("x86_64-pc-windows-msvc");
  expect(() => prepareEnterprise(f.app, f.payload, "x86_64-pc-windows-msvc", sha, version)).toThrow();
  expect(existsSync(join(f.native, "screenpipe-package.json"))).toBe(false);
});

test("historical sources without runtime package support cannot masquerade as a shared Enterprise build", () => {
  const target = "x86_64-pc-windows-msvc";
  const f = fixture(target);
  writeFileSync(join(f.native, "Cargo.toml"), '[package]\ndefault-run = "screenpipe-app"\n');
  expect(() => capture(f.app, target, sha, version, f.payload)).toThrow("predates shared package runtime support");
  expect(existsSync(f.payload)).toBe(false);
});
