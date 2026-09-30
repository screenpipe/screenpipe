// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
/** Answers share the existing user-owned correction storage and learning path. */
export type WorkflowAnswer = { question: string; answer: string };
const prefix = "\n\nWorkflow answers (user supplied):\n";
export function readWorkflowAnswers(correction = ""): WorkflowAnswer[] {
  const start = correction.lastIndexOf(prefix);
  if (start < 0) return [];
  try {
    const value: unknown = JSON.parse(correction.slice(start + prefix.length).split("\n")[0]);
    return Array.isArray(value) ? value.filter((a): a is WorkflowAnswer =>
      a && typeof a.question === "string" && typeof a.answer === "string") : [];
  } catch { return []; }
}
export function writeWorkflowAnswers(correction: string | undefined, answers: WorkflowAnswer[]): string {
  let text = correction ?? "";
  const start = text.lastIndexOf(prefix);
  if (start >= 0 && (readWorkflowAnswers(text).length || text.slice(start + prefix.length).split("\n")[0] === "[]")) {
    const end = text.indexOf("\n", start + prefix.length);
    text = text.slice(0, start) + (end < 0 ? "" : text.slice(end));
  }
  // Keep answers to questions no longer in the generated list as user context.
  const merged = new Map(readWorkflowAnswers(correction).map(a => [a.question, a]));
  for (const a of answers) merged.set(a.question, { question: a.question, answer: a.answer.trim() });
  const result = text.trimEnd() + prefix + JSON.stringify([...merged.values()].filter(a => a.answer));
  if (new TextEncoder().encode(result).length > 20000) throw new Error("These answers are too long to save. Shorten them and try again.");
  return result;
}
