// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BUNDLED_SKILLS } from "./generated/bundled-skills";
import { BUNDLED_SKILLS_TOOL, readBundledSkills } from "./bundled-skills";

const root = path.resolve(__dirname, "../../..");
const registry = readFileSync(path.join(root, "crates/screenpipe-core/src/starter_skills.rs"), "utf8");
const starters = [...registry.matchAll(/"(screenpipe-[^"]+)",\s*include_str!\(/g)].map(match => match[1]).sort();

describe("public bundled skill access", () => {
  it("lists every native starter and both API guides without loading their bodies", () => {
    expect(BUNDLED_SKILLS.map(skill => skill.name)).toEqual(["screenpipe-api", "screenpipe-cli", ...starters]);
    const result = readBundledSkills();
    const catalog = JSON.parse(result.content[0].text);
    expect(catalog.skills).toEqual(BUNDLED_SKILLS.map(({ name, description }) => ({ name, description })));
    expect(catalog.skills.every((skill: object) => !("markdown" in skill))).toBe(true);
    expect(BUNDLED_SKILLS_TOOL.annotations?.readOnlyHint).toBe(true);
  });

  it("reads the complete canonical files, including newly bundled handoff guidance", () => {
    expect(starters).toContain("screenpipe-project-handoff");
    for (const skill of BUNDLED_SKILLS) {
      const canonical = readFileSync(path.join(root, "crates/screenpipe-core/assets/skills", skill.name, "SKILL.md"), "utf8");
      expect(readBundledSkills({ name: skill.name }).content[0].text).toBe(canonical);
    }
  });

  it.each(["../private", "/Users/example/.codex/skills/private/SKILL.md", "screenpipe-learned-private", "toString", "__proto__", ""])("does not read private or arbitrary paths: %s", name => {
    expect(readBundledSkills({ name }).isError).toBe(true);
  });

  it.each([{ name: 7 }, { query: "private" }, { name: null }])("rejects invalid arguments", args => {
    expect(readBundledSkills(args).isError).toBe(true);
  });
});
