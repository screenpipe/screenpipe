// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Transfer a verified compiled payload between release jobs. Enterprise never
// falls back to compiling when that payload is missing or incompatible.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Manifest = { sha: string; version: string; target: string; runtimePackageIdentity: true; files: Record<string, string> };
type CargoManifest = { package: { "default-run": string; metadata?: { screenpipe?: { "shared-package-runtime"?: boolean } } } };
const metadataFile = "screenpipe-package.json";
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
function requireRevision(sha: string, version: string, target: string) {
  if (!/^[a-f0-9]{40}$/i.test(sha) || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error("Expected an immutable source SHA and app version");
  if (!["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc", "x86_64-unknown-linux-gnu"].includes(target)) throw new Error(`Unsupported desktop target: ${target}`);
}
export function capture(app: string, target: string, sha: string, version: string, output: string) {
  requireRevision(sha, version, target);
  const cargo = Bun.TOML.parse(readFileSync(join(app, "src-tauri/Cargo.toml"), "utf8")) as CargoManifest;
  if (cargo.package.metadata?.screenpipe?.["shared-package-runtime"] !== true) throw new Error("Requested source predates shared package runtime support; use its original release workflow for recovery");
  mkdirSync(output, { recursive: true });
  const release = join(app, "src-tauri/target", target, "release");
  if (target.endsWith("apple-darwin")) {
    const bundle = join(release, "bundle/macos/screenpipe.app");
    if (!existsSync(bundle)) throw new Error(`Shared standard app bundle missing: ${bundle}`);
    run("tar", ["-czf", join(output, "application.tar.gz"), "-C", join(release, "bundle/macos"), "screenpipe.app"]);
  } else {
    const suffix = target.includes("windows") ? ".exe" : "";
    const configPath = join(app, "src-tauri/tauri.conf.json");
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
    const name = config.mainBinaryName ?? cargo.package["default-run"];
    if (!name) throw new Error("Shared build has no configured main executable");
    const binary = join(release, name + suffix);
    if (!existsSync(binary)) throw new Error(`Shared desktop executable missing: ${binary}`);
    cpSync(binary, join(output, "screenpipe-app" + suffix));
  }
  const payload = target.endsWith("apple-darwin") ? "application.tar.gz" : `screenpipe-app${target.includes("windows") ? ".exe" : ""}`;
  const manifest: Manifest = { sha, version, target, runtimePackageIdentity: true, files: { [payload]: hash(join(output, payload)) } };
  writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
}

export function verify(input: string, target: string, sha: string, version: string): Manifest {
  requireRevision(sha, version, target);
  const manifest = JSON.parse(readFileSync(join(input, "manifest.json"), "utf8")) as Manifest;
  if (manifest.runtimePackageIdentity !== true) throw new Error("Shared build does not declare runtime package identity support");
  if (manifest.sha !== sha || manifest.version !== version || manifest.target !== target) throw new Error("Shared build revision, version or target mismatch; select its matching Release App run");
  const expected = target.endsWith("apple-darwin") ? "application.tar.gz" : `screenpipe-app${target.includes("windows") ? ".exe" : ""}`;
  if (Object.keys(manifest.files).length !== 1 || !manifest.files[expected]) throw new Error("Shared build manifest must contain its compiled application payload");
  if (hash(join(input, expected)) !== manifest.files[expected]) throw new Error(`Shared build checksum mismatch: ${expected}`);
  return manifest;
}

export function prepareEnterprise(app: string, input: string, target: string, sha: string, version: string) {
  verify(input, target, sha, version);
  const native = join(app, "src-tauri");
  const config = JSON.parse(readFileSync(join(native, "tauri.enterprise.conf.json"), "utf8"));
  const identity = { identifier: config.identifier, product_name: config.productName, version, updater: config.plugins.updater, deep_link: config.plugins["deep-link"] };
  const release = join(native, "target", target, "release");
  mkdirSync(release, { recursive: true });
  // Discard only this job's generated bundles, so packaging cannot merge stale
  // files from an older release into the verified incoming application.
  rmSync(join(release, "bundle"), { recursive: true, force: true });
  if (target.endsWith("apple-darwin")) {
    const bundles = join(release, "bundle/macos");
    mkdirSync(bundles, { recursive: true });
    // The archive is produced by our successful standard package job and is
    // checksummed above. No dependency compilation or frontend build runs here.
    run("tar", ["-xzf", join(input, "application.tar.gz"), "-C", bundles]);
    const standard = join(bundles, "screenpipe.app");
    const enterprise = join(bundles, "screenpipe enterprise.app");
    renameSync(standard, enterprise);
    const resources = join(enterprise, "Contents/Resources");
    mkdirSync(resources, { recursive: true });
    writeFileSync(join(resources, metadataFile), JSON.stringify(identity));
    const plist = join(enterprise, "Contents/Info.plist");
    run("python3", ["-c", `
import json, plistlib, sys
path, identifier, product, schemes = sys.argv[1:]
with open(path, 'rb') as source:
    info = plistlib.load(source)
info.update(CFBundleIdentifier=identifier, CFBundleName=product, CFBundleDisplayName=product,
            CFBundleURLTypes=[dict(CFBundleURLName=identifier, CFBundleURLSchemes=json.loads(schemes))])
with open(path, 'wb') as output:
    plistlib.dump(info, output, sort_keys=False)
`, plist, identity.identifier, identity.product_name, JSON.stringify(config.plugins["deep-link"].desktop.schemes)]);
    return enterprise;
  }
  const executable = `screenpipe-app${target.includes("windows") ? ".exe" : ""}`;
  const packagedName = target.includes("windows") ? "screenpipe-app" : "screenpipe-enterprise";
  cpSync(join(input, executable), join(release, packagedName + (target.includes("windows") ? ".exe" : "")));
  writeFileSync(join(native, metadataFile), JSON.stringify(identity));
  // Platform resource maps supersede the base resource array in Tauri.
  const platform = target.includes("windows") ? "windows" : "linux";
  const platformFile = join(native, `tauri.${platform}.conf.json`);
  const resources = (existsSync(platformFile) ? JSON.parse(readFileSync(platformFile, "utf8")).bundle?.resources : undefined) ?? config.bundle.resources;
  const bundleResources = Array.isArray(resources) ? [...resources, metadataFile] : { ...resources, [metadataFile]: metadataFile };
  const overlay = { mainBinaryName: packagedName, bundle: { resources: bundleResources } };
  writeFileSync(join(native, "shared-build-bundle.conf.json"), JSON.stringify(overlay));
  return join(native, "shared-build-bundle.conf.json");
}

if (import.meta.main) {
  const [command, appPath, target, sha, version, payload] = process.argv.slice(2);
  if (!["capture", "prepare"].includes(command) || !payload) throw new Error("Usage: shared-desktop-build.ts <capture|prepare> <app-dir> <target> <sha> <version> <payload-dir>");
  const app = resolve(appPath);
  if (command === "capture") capture(app, target, sha, version, resolve(payload));
  else prepareEnterprise(app, resolve(payload), target, sha, version);
}
