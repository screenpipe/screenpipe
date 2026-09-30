// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Bun's hoisted lockfile keys encode nested packages as parent/child, including
// scoped names. Build the whole allowlist before deleting anything.
export function pruneDependencies(appDirectory: string): string[] {
  const lock = Bun.JSONC.parse(readFileSync(join(appDirectory, "bun.lock"), "utf8"));
  if (lock?.lockfileVersion !== 1 || !lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    throw new Error("Unsupported Bun lockfile; refusing to prune installed dependencies");
  }
  const expected = new Set<string>();
  for (const key of Object.keys(lock.packages)) {
    const names = key.match(/(?:@[^/]+\/)?[^/]+/g) ?? [];
    if (!names.length || names.join("/") !== key || names.some(name => name.split("/").some(part => !part || part === "." || part === ".." || part.includes("\\") || part.includes(":")))) {
      throw new Error(`Invalid Bun package key: ${key}`);
    }
    expected.add(names.join("/node_modules/"));
  }
  if (!expected.size) throw new Error("Empty Bun package list; refusing to prune installed dependencies");

  const removed: string[] = [];
  const visit = (modules: string, prefix = "") => {
    if (!existsSync(modules)) return;
    // Never follow a package's junction into an external dependency tree.
    if (lstatSync(modules).isSymbolicLink()) throw new Error(`Refusing linked node_modules: ${modules}`);
    const inspect = (name: string) => {
      const path = join(modules, name);
      const key = prefix + name;
      if (!expected.has(key)) {
        rmSync(path, { recursive: true, force: true });
        removed.push(key);
      } else if (!lstatSync(path).isSymbolicLink()) {
        visit(join(path, "node_modules"), `${key}/node_modules/`);
      }
    };
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue; // Bun metadata and executable shims.
      if (entry.name.startsWith("@") && entry.isDirectory()) {
        for (const child of readdirSync(join(modules, entry.name))) inspect(`${entry.name}/${child}`);
      } else if (entry.isDirectory() || entry.isSymbolicLink()) {
        inspect(entry.name);
      }
    }
  };
  visit(join(appDirectory, "node_modules"));
  return removed;
}

if (import.meta.main) {
  const removed = pruneDependencies(process.cwd());
  console.log(`Pruned ${removed.length} obsolete installed package(s): ${removed.join(", ") || "none"}`);
}
