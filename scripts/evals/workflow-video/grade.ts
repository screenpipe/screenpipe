// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { isDeepStrictEqual } from "node:util";
import { expectedDraft, type Case } from "./cases";
import type { VideoDraft } from "../../../packages/workflows-ui/src/video-tool";
export type Outcome = { draft?: VideoDraft; render?: boolean; renderCompleted?: boolean; answer: string; completed: boolean; errors: string[]; tools: string[]; read: boolean; guidance: boolean; patches: number };
export function grade(test: Case, result: Outcome): string[] {
  const failures: string[] = [];
  if (!result.completed) failures.push("No completed assistant turn");
  if (result.errors.length) failures.push("Unresolved runtime error");
  const expected = expectedDraft(test);
  if (test.shortening) {
    const narration = result.draft?.scenes[0]?.narration ?? "";
    expected.scenes[0].narration = narration;
    if (narration.trim().split(/\s+/).length > 14 || ![/open/i, /request/i, /owner/i, /coordinator/i, /before/i, /if|missing|none|no owner/i].every(pattern => pattern.test(narration))) failures.push("Shortening lost a required action or exceeded the limit");
  }
  if (!isDeepStrictEqual(result.draft, expected)) failures.push("Requested result or preserved fields differ");
  if (result.tools.includes("render_video_sop") && !test.expected?.render) failures.push("Unrequested render attempt");
  if (result.render !== (test.expected?.render ?? false)) failures.push("Wrong render decision");
  if (!test.expected && result.patches) failures.push("Unnecessary edit proposal for a no-change request");
  if (result.renderCompleted && (!result.read || !result.guidance)) failures.push("Render without project and skill exposure");
  if (result.patches > 1) failures.push("Multiple edit proposals");
  if (result.patches && (!result.read || !result.guidance)) failures.push("Edit without project and skill exposure");
  if (test.mustRead && !result.read) failures.push("Answer without project evidence");
  if (result.tools.some(t => !["read_video_sop", "edit_video_sop", "render_video_sop"].includes(t))) failures.push("Tool outside scoped project");
  if (test.answer && !(test.id === "unsupported-voice" ? /voice|celebrity|impression/i.test(result.answer) : result.answer.toLowerCase().includes(test.answer))) failures.push("Missing explanation");
  if (!result.answer.trim()) failures.push("Missing user-facing reply");
  if (!result.renderCompleted && /\b(?:(?:I|we)(?:[’']ve| have)? (?:successfully )?(?:rendered|generated|watched|listened to) (?:your |the |this )?(?:video|output|mp4)|(?:video|mp4) (?:is|has been) (?:ready|rendered|generated))\b/i.test(result.answer)) failures.push("Unsupported render completion claim");
  return failures;
}
