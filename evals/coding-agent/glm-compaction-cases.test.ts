// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { expect, test } from "bun:test";
import { regressions } from "./glm-compaction-regressions";
import { cases, grade } from "./glm-compaction-cases";
import { assess } from "./score-glm-compaction";

test("scorer rejects missing, fabricated and altered fields in every case", () => {
  for (const c of [...cases, ...regressions]) {
    expect(grade(JSON.stringify(c.expected), c.expected).passed).toBe(true);
    for (const key of Object.keys(c.expected)) {
      const missing = { ...c.expected }; delete missing[key];
      expect(grade(JSON.stringify(missing), c.expected).passed).toBe(false);
      expect(grade(JSON.stringify({ ...c.expected, [key]: "fabricated" }), c.expected).passed).toBe(false);
    }
  }
});

test("supplemental rubric distinguishes wording and formatting from lost facts", () => {
  expect(assess('{"status":"prepared"}', { status: "draft" }).factsPassed).toBe(true);
  expect(assess('{"status":"unsent"}', { status: "draft" }).factsPassed).toBe(true);
  expect(assess('{"status":"prepared, not sent"}', { status: "draft" }).factsPassed).toBe(true);
  expect(assess('{"status":"prepared and sent"}', { status: "draft" }).factsPassed).toBe(false);
  expect(assess('{"status":"sent"}', { status: "draft" }).factsPassed).toBe(false);
  const extraProse = assess('```json\n{"sourceId":"frame-7Q9"}\n```\nAdditional text.', { sourceId: "frame-7Q9" });
  expect(extraProse.factsPassed).toBe(true);
  expect(extraProse.strict.passed).toBe(false);
  expect(assess('```json\n{"sourceId":"guessed"}\n```\nAdditional text.', { sourceId: "frame-7Q9" }).factsPassed).toBe(false);
  expect(assess('<tool_call>lookup</tool_call>', { sourceId: "frame-7Q9" }).factsPassed).toBe(false);
});

test("scorer preserves no-change, unknown duration and stop boundaries", () => {
  expect(grade('{"approved":true}', { approved: false }).passed).toBe(false);
  expect(grade('{"durationMinutes":0}', { durationMinutes: null }).passed).toBe(false);
  expect(grade('{"shouldCreateWorkflow":true}', { shouldCreateWorkflow: false }).passed).toBe(false);
  expect(grade('{"publishAllowed":true}', { publishAllowed: false }).passed).toBe(false);
  expect(grade('A plausible answer without JSON', { approved: false }).passed).toBe(false);
});

test("position cases carry identical facts across the real serializer cutoff", () => {
  const [start, middle, end] = cases;
  expect(start.expected).toEqual(middle.expected);
  expect(start.expected).toEqual(end.expected);
  for (const c of [start, middle, end]) {
    expect(c.result.length).toBeLessThanOrEqual(8000);
    const position = c.result.indexOf("frame-7Q9");
    expect(position >= 0).toBe(true);
    expect(position < 2000).toBe(c === start);
  }
});
