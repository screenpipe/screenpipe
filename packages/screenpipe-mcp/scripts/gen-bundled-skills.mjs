// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readBundledSkill, readStarterSkills } from "../../../scripts/lib/skill-bundle.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const skills = [
  await readBundledSkill(repoRoot, "screenpipe-api"),
  await readBundledSkill(repoRoot, "screenpipe-cli"),
  ...await readStarterSkills(repoRoot),
];
const output = path.join(repoRoot, "packages/screenpipe-mcp/src/generated/bundled-skills.ts");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `// GENERATED FILE - do not edit by hand.\n// Source: crates/screenpipe-core/assets/skills and src/starter_skills.rs\n// Regenerate: bun scripts/gen-bundled-skills.mjs\n\nexport const BUNDLED_SKILLS = ${JSON.stringify(skills, null, 2)} as const;\n`);
