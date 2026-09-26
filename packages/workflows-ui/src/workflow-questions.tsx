// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { WorkflowMap } from "./model";
import type { WorkflowComposerAccessory } from "./assistant";
import { readWorkflowAnswers, writeWorkflowAnswers } from "./workflow-answers";
import styles from "./workflow-question.module.css";

export function WorkflowQuestions({ workflow, save, composerAccessory, active = true }: {
  workflow: WorkflowMap;
  save?: (correction: string) => Promise<WorkflowMap>;
  composerAccessory?: WorkflowComposerAccessory;
  active?: boolean;
}) {
  const questions = [...new Set((workflow.openQuestions ?? []).map(q => q.trim()).filter(Boolean))];
  const initial = () => Object.fromEntries(readWorkflowAnswers(workflow.userCorrection).map(a => [a.question, a.answer]));
  const [answers, setAnswers] = useState<Record<string, string>>(initial);
  const [saved, setSaved] = useState<Record<string, string>>(initial);
  const baseline = useRef(saved);
  useEffect(() => {
    const latest = Object.fromEntries(readWorkflowAnswers(workflow.userCorrection).map(a => [a.question, a.answer]));
    const prior = baseline.current;
    setAnswers(current => ({ ...latest, ...Object.fromEntries(Object.entries(current).filter(([q, a]) => a !== (prior[q] ?? ""))) }));
    baseline.current = latest;
    setSaved(latest);
  }, [workflow.userCorrection]);
  const [dictating, setDictating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const saving = useRef(false);
  const [selected, setSelected] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const changed = questions.some(q => (answers[q] ?? "").trim() !== (saved[q] ?? "").trim());
  async function submit() {
    if (!save || !changed || dictating || saving.current) return;
    saving.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const next = await save(writeWorkflowAnswers(workflow.userCorrection, questions.filter(q => (answers[q] ?? "").trim() !== (saved[q] ?? "").trim()).map(question => ({ question, answer: answers[question] ?? "" }))));
      const persisted = Object.fromEntries(readWorkflowAnswers(next.userCorrection).map(a => [a.question, a.answer]));
      baseline.current = persisted; setAnswers(persisted); setSaved(persisted); setNotice("Answers saved for the next workflow update.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn’t save answers. Your draft is still here. Try again."); }
    finally { saving.current = false; setBusy(false); }
  }
  if (!questions.length) return null;
  return <section className={styles.questions} aria-label="Open questions">
    <h2>Open questions</h2>
    <p className={styles.hint}>{save ? composerAccessory ? "Type an answer, or select a field to dictate. Saved answers refine future updates." : "Fill in what’s missing. Saved answers refine future updates." : "Answers are unavailable in this view."}</p>
    <form onSubmit={e => { e.preventDefault(); void submit(); }}>
      {questions.map((question, index) => <div key={question} className={styles.field} data-chat-pane-id={`${id}-${index}`}>
        <label htmlFor={`${id}-${index}`}>{question}</label>
        <textarea id={`${id}-${index}`} ref={selected === question ? inputRef : undefined}
          rows={2} value={answers[question] ?? ""} placeholder="Your answer…" disabled={!save || busy}
          onFocus={() => setSelected(question)} onChange={e => { setAnswers(a => ({ ...a, [question]: e.target.value })); setNotice(""); }} />
        {save && active && selected === question && <div className={styles.voice}>
          {composerAccessory?.({ inputValue: answers[question] ?? "", inputRef, disabled: busy, onBusyChange: setDictating,
            sessionId: `workflow-answer:${workflow.id ?? workflow.title}:${question}`, shortcutsEnabled: false,
            onValueChange: value => { setAnswers(a => ({ ...a, [question]: value })); setNotice(""); } })}
        </div>}
      </div>)}
      {save && <div className={styles.actions}>
        <button type="submit" disabled={!changed || busy || dictating}>{busy ? "Saving…" : "Save answers"}</button>
        <span role="status">{notice || (changed ? "Unsaved answers" : "")}</span>
      </div>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  </section>;
}
