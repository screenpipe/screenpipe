// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { expect, test } from "bun:test";
import { cases, expectedDraft } from "./cases";
import { grade, type Outcome } from "./grade";
const example = cases.find(c => c.id === "rename")!;
const good = (): Outcome => ({ draft: expectedDraft(example), render: false, answer: "Renamed the first section.", completed: true, errors: [], tools: ["read_video_sop", "edit_video_sop"], read: true, guidance: true, patches: 1 });
test("accepts an evidenced exact edit and an evidenced no-change answer", () => {
  expect(grade(example, good())).toEqual([]);
  const question = cases.find(c => c.id === "question")!;
  expect(grade(question, { ...good(), draft: expectedDraft(question), patches: 0, answer: "Ask the coordinator before proceeding." })).toEqual([]);
});
for (const [name, mutate] of Object.entries<(o: Outcome) => void>({
  "no actual change": o => { o.draft!.scenes[0].title = "Prepare"; },
  "dropped exception": o => { o.draft!.scenes[0].narration = "Proceed."; },
  "failed unrequested render attempt": o => { o.tools.push("render_video_sop"); },
  "unrequested render": o => { o.render = true; },
  "missing completion": o => { o.completed = false; },
  "missing skill exposure": o => { o.guidance = false; },
  "unscoped tool": o => { o.tools.push("bash"); },
  "two patches": o => { o.patches = 2; },
  "invented render success": o => { o.answer = "I generated your video."; },
  "missing reply": o => { o.answer = ""; },
  "runtime failure": o => { o.errors.push("provider error"); },
})) test(`rejects ${name}`, () => { const o = good(); mutate(o); expect(grade(example, o).length).toBeGreaterThan(0); });

test("accepts a truthful denial of an unsupported celebrity voice without mistaking negation for success", () => {
  const c = cases.find(c => c.id === "unsupported-voice")!;
  expect(grade(c, { ...good(), draft: expectedDraft(c), patches: 0, answer: "This editor doesn’t support switching to a celebrity impression. I haven’t made any changes or rendered the video." })).toEqual([]);
});
test("rejects a redundant proposal even if final state is identical", () => {
  const c = cases.find(c => c.id === "no-change")!;
  expect(grade(c, { ...good(), draft: expectedDraft(c) })).toContain("Unnecessary edit proposal for a no-change request");
});

test("shortening scorer rejects a dropped exception and unrelated edits", () => {
  const c = cases.find(c => c.shortening)!;
  const o = { ...good(), draft: expectedDraft(c) };
  o.draft.scenes[0].narration = "Open request; confirm owner. If missing, ask coordinator before proceeding.";
  expect(grade(c, o)).toEqual([]);
  o.draft.scenes[0].narration = "Open request; confirm owner.";
  expect(grade(c, o).length).toBeGreaterThan(0);
  o.draft.scenes[0].narration = "Open request; confirm owner. If missing, ask coordinator before proceeding.";
  o.draft.scenes[1].title = "Unrequested change";
  expect(grade(c, o)).toContain("Requested result or preserved fields differ");
});
