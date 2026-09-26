// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Check, Loader2, Mic, Square, Undo2 } from "lucide-react";
import type { WorkflowMap } from "./model";
import { readWorkflowAnswers, writeWorkflowAnswers } from "./workflow-answers";
import { QuestionnaireVoiceSession, type QuestionnaireVoice, type VoiceState } from "./questionnaire-voice";
import { LiveVoiceFill } from "./live-voice-fill";
import styles from "./workflow-question.module.css";

const EXTRA = "Anything else we should know?";
export function WorkflowQuestions({ workflow, save, voice, active = true }: {
  workflow: WorkflowMap;
  save?: (correction: string) => Promise<WorkflowMap>;
  voice?: QuestionnaireVoice;
  active?: boolean;
}) {
  const questions = [...new Set((workflow.openQuestions ?? []).map(q => q.trim()).filter(q => q && q !== EXTRA))];
  const fields = [...questions, EXTRA];
  const initial = () => Object.fromEntries(readWorkflowAnswers(workflow.userCorrection).map(a => [a.question, a.answer]));
  const [answers, setAnswers] = useState<Record<string, string>>(initial);
  const [saved, setSaved] = useState<Record<string, string>>(initial);
  const fieldsRef = useRef(fields); fieldsRef.current = fields;
  const baseline = useRef(saved);
  const locked = useRef(new Set(Object.keys(saved).filter(q => saved[q])));
  const beforeVoice = useRef<Record<string, string>>({});
  const [voiceFields, setVoiceFields] = useState<Set<string>>(new Set());
  useEffect(() => {
    const latest = Object.fromEntries(readWorkflowAnswers(workflow.userCorrection).map(a => [a.question, a.answer]));
    const prior = baseline.current;
    setAnswers(current => ({ ...latest, ...Object.fromEntries(Object.entries(current).filter(([q, a]) => a !== (prior[q] ?? ""))) }));
    Object.keys(latest).filter(q => latest[q] !== prior[q]).forEach(q => locked.current.add(q));
    baseline.current = latest; setSaved(latest);
  }, [workflow.userCorrection]);
  const [voiceState, setVoiceState] = useState<VoiceState>({ status: "idle", remaining: 120 });
  const [transcript, setTranscript] = useState("");
  const transcriptRef = useRef("");
  const [filling, setFilling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const saving = useRef(false);
  const session = useRef<QuestionnaireVoiceSession>();
  const filler = useRef<LiveVoiceFill>();
  const prefix = useRef("");
  const id = useId();
  const recording = voiceState.status === "connecting" || voiceState.status === "listening";
  const changed = fields.some(q => (answers[q] ?? "").trim() !== (saved[q] ?? "").trim());
  useEffect(() => {
    if (!voice || !active) { setFilling(false); return; }
    const abort = new AbortController();
    let mounted = true;
    const fill = new LiveVoiceFill(async text => {
      try {
        const patches = await voice.fill({ questions: fieldsRef.current, transcript: text, locked: [...locked.current] }, abort.signal);
        if (!mounted) return;
        setAnswers(current => {
          const next = { ...current };
          for (const patch of patches) {
            // Manual edits made during inference also win over its late result.
            if (locked.current.has(patch.question) || !fieldsRef.current.includes(patch.question) || !patch.quote.trim() || !text.includes(patch.quote)) continue;
            if (!(patch.question in beforeVoice.current)) beforeVoice.current[patch.question] = current[patch.question] ?? "";
            next[patch.question] = patch.answer;
          }
          return next;
        });
        setVoiceFields(current => new Set([...current, ...patches.filter(p => !locked.current.has(p.question) && fieldsRef.current.includes(p.question) && p.quote.trim() && text.includes(p.quote)).map(p => p.question)]));
        setError("");
      } catch (cause) { if (mounted) setError(cause instanceof Error ? cause.message : "Could not fill answers. Your words are kept. Try again."); }
    }, value => { if (mounted) setFilling(value); });
    filler.current = fill;
    const connection = new QuestionnaireVoiceSession(voice, state => {
      if (!mounted) return;
      setVoiceState(state);
      if (state.status === "stopped" || state.status === "error") fill.enqueue(transcriptRef.current, true);
    }, text => {
      if (!mounted) return;
      const combined = [prefix.current, text].filter(Boolean).join("\n").slice(-24000);
      transcriptRef.current = combined; setTranscript(combined); fill.enqueue(combined);
    });
    session.current = connection;
    return () => { mounted = false; connection.stop(); fill.dispose(); abort.abort(); session.current = undefined; filler.current = undefined; setVoiceState(s => ({ ...s, status: "stopped", level: undefined })); };
  }, [voice, active]);
  function manual(question: string, value: string) {
    locked.current.add(question);
    setAnswers(a => ({ ...a, [question]: value })); setNotice("");
    setVoiceFields(current => { const next = new Set(current); next.delete(question); return next; });
  }
  function toggleVoice() {
    if (recording) { session.current?.stop(); return; }
    prefix.current = transcriptRef.current; setError(""); setNotice("");
    void session.current?.start(workflow.title.slice(0, 300), questions.slice(0, 30));
  }
  async function submit() {
    if (!save || !changed || recording || filling || saving.current) return;
    saving.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const next = await save(writeWorkflowAnswers(workflow.userCorrection, fields.filter(q => (answers[q] ?? "").trim() !== (saved[q] ?? "").trim()).map(question => ({ question, answer: answers[question] ?? "" }))));
      const persisted = Object.fromEntries(readWorkflowAnswers(next.userCorrection).map(a => [a.question, a.answer]));
      baseline.current = persisted; setAnswers(persisted); setSaved(persisted); Object.keys(persisted).forEach(q => locked.current.add(q)); setVoiceFields(new Set()); setNotice("Answers saved for the next workflow update.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn’t save answers. Your draft is still here. Try again."); }
    finally { saving.current = false; setBusy(false); }
  }
  if (!questions.length) return null;
  const answered = questions.filter(q => answers[q]?.trim()).length;
  return <section className={styles.questions} aria-label="Questions and feedback">
    <div className={styles.heading}>
      <div><h2>Help make this workflow accurate</h2><p className={styles.hint}>{save ? "Answer what you know. Skip anything you’re unsure about, or talk through the questions." : "Answers are unavailable in this view."}</p></div>
      {voice && save && <button type="button" className={styles.voiceButton} disabled={!active || busy || (!recording && filling)} onClick={toggleVoice}>
        {recording ? <Square size={14} fill="currentColor" /> : <Mic size={16} />}{recording ? "Stop recording" : "Answer with voice"}
      </button>}
    </div>
    <p className={styles.progress} role="status">{answered} of {questions.length} answered · All optional</p>
    {(recording || transcript || voiceState.error) && <div className={styles.voicePanel}>
      <div className={styles.voiceStatus}><span>{voiceState.status === "connecting" ? <Loader2 size={16} /> : <Mic size={16} />}{voiceState.status === "connecting" ? "Connecting microphone…" : recording ? "Listening" : voiceState.status === "error" ? "Recording interrupted" : "Recording stopped"}</span>
        {recording && <span><meter aria-label="Microphone level" min={0} max={1} value={voiceState.level ?? 0} />{Math.floor(voiceState.remaining / 60)}:{String(voiceState.remaining % 60).padStart(2, "0")} left</span>}
      </div>
      <p className={styles.hint}>Talk naturally. Answers and a summary update as you speak. Anything you edit by hand stays unchanged.</p>
      <p className={styles.progress} aria-live="polite">{filling ? "Updating answers and summary…" : voiceState.error ? "You can still answer by hand." : transcript ? "Review your answers and summary below." : "Waiting for your words…"}</p>
      {voiceState.error && <p className={styles.error} role="alert">{voiceState.error}</p>}
      {transcript && <details open={recording}><summary>{recording ? "Live transcript" : "Original transcript"}</summary><p className={styles.transcript}>{transcript}</p></details>}
      {!recording && transcript && <button type="button" className={styles.textButton} disabled={filling || busy} onClick={() => filler.current?.enqueue(transcriptRef.current, true, true)}>Retry filling from voice notes</button>}
    </div>}
    <form onSubmit={e => { e.preventDefault(); void submit(); }}>
      {fields.map((question, index) => <div key={question} className={styles.field}>
        <label htmlFor={`${id}-${index}`}><span className={styles.number}>{index < questions.length ? String(index + 1).padStart(2, "0") : ""}</span><span>{question}</span>{answers[question]?.trim() && <Check size={16} aria-label="Answered" />}</label>
        <div className={styles.answer}>
          {question === EXTRA && <p className={styles.hint}>Add a missing step, an exception, or other feedback. When you speak, your summary appears here.</p>}
          <textarea id={`${id}-${index}`} aria-label={question} rows={question === EXTRA ? 3 : 2} maxLength={4000} value={answers[question] ?? ""} placeholder={question === EXTRA ? "Add any other feedback…" : "Your answer…"} disabled={!save || busy} onChange={e => manual(question, e.target.value)} />
          <div className={styles.fieldActions}>
            {question !== EXTRA && <label><input type="checkbox" checked={answers[question] === "Not sure"} disabled={!save || busy} onChange={e => manual(question, e.target.checked ? "Not sure" : "")} />Not sure</label>}
            {answers[question]?.trim() && <button type="button" disabled={!save || busy} onClick={() => manual(question, "")}>Clear</button>}
            {voiceFields.has(question) && <span><Mic size={12} />{question === EXTRA ? "Summary from voice" : "Filled from voice"}<button type="button" disabled={busy} aria-label={`Undo voice answer: ${question}`} onClick={() => manual(question, beforeVoice.current[question] ?? "")}><Undo2 size={12} />Undo</button></span>}
          </div>
        </div>
      </div>)}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {save && <div className={styles.actions}><span role="status">{notice || "Review before saving. Saved answers refine future workflow updates."}</span><button type="submit" disabled={!changed || busy || recording || filling}>{busy ? "Saving…" : "Save answers"}</button></div>}
    </form>
  </section>;
}
