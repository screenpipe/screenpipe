// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const launcher = new URL("../e2e/helpers/app-launcher.ts", import.meta.url).href;

// Import configuration in an isolated process. Never call startApp: these tests
// must not launch native capture, kill ports, or touch a developer's app data.
function seededFlags(override?: string): string[] {
  const env = { ...process.env };
  if (override === undefined) delete env.SCREENPIPE_E2E_SEED;
  else env.SCREENPIPE_E2E_SEED = override;
  const result = spawnSync(process.execPath, ["--eval", `
    const { E2E_SEED_FLAGS } = await import(${JSON.stringify(launcher)});
    console.log(JSON.stringify(E2E_SEED_FLAGS.split(",")));
  `], { env, encoding: "utf8" });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

test("broad desktop suite seeds fictional authentication before native server startup", () => {
  const flags = seededFlags();
  expect(flags).toContain("cloud-authenticated");
  expect(flags).toContain("onboarding");
  expect(flags).toContain("no-recording");
  expect(flags).toContain("search-fixture");
});

for (const [name, override, expected] of [
  ["signed-out first run", "no-recording", ["no-recording"]],
  ["signed-out cloud fallback", "onboarding,cloud-audio-fallback", ["onboarding", "cloud-audio-fallback"]],
  ["explicit empty seed", "", [""]],
] as const) {
  test(`preserves ${name} override without adding authentication`, () => {
    const flags = seededFlags(override);
    expect(flags).toEqual([...expected]);
    expect(flags).not.toContain("cloud-authenticated");
  });
}
