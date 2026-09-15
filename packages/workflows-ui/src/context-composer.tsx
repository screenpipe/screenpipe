// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React, { useEffect, useRef, useState } from "react";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import type { WorkflowsPlatform } from "./platform";
import type { WorkProfile } from "./model";
import { CONTEXT_LABELS, MAX_CONTEXT_SOURCE_TEXT, mergeContextUpdate, normalizeContextWebsite, validateContextDocuments, type ContextDocument, type ContextField } from "./context-tool";
import type { ImportResult } from "./context-import";
import styles from "./workflows-app.module.css";

export function ContextComposer({ profile, update, fillContext, discoverContext = false, onFields }: {
  discoverContext?: boolean;
  profile: WorkProfile;
  update: (profile: WorkProfile) => void;
  fillContext: NonNullable<WorkflowsPlatform["fillContext"]>;
  onFields: (fields: ContextField[]) => void;
}) {
  const [text, setText] = useState("");
  const [documents, setDocuments] = useState<ContextDocument[]>([]);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const worker = useRef<Worker | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const request = useRef<AbortController | null>(null);
  const latest = useRef({ profile, update, documents });
  latest.current = { profile, update, documents };
  useEffect(() => () => {
    request.current?.abort(); worker.current?.terminate(); clearTimeout(timer.current);
  }, []);
  const readFiles = (files: File[]) => {
    if (!files.length || reading || busy) return;
    setError(""); setWarnings([]); setReading(true);
    const done = () => { worker.current?.terminate(); worker.current = null; clearTimeout(timer.current); setReading(false); };
    try {
      const current = new Worker(new URL("./context-import.worker.ts", import.meta.url), { type: "module" });
      worker.current = current;
      current.onerror = () => { done(); setError("Could not read files. Paste their text or try again."); };
      current.onmessage = (event: MessageEvent<{ result?: ImportResult; error?: string }>) => {
        if (worker.current !== current) return;
        if (event.data.error) { done(); setError(event.data.error); return; }
        if (!event.data.result) return;
        try {
          const next = [...latest.current.documents, ...event.data.result.sources];
          validateContextDocuments(next); setDocuments(next); setWarnings(event.data.result.warnings);
        } catch (error) { setError((error as Error).message); }
        done();
      };
      timer.current = setTimeout(() => { done(); setError("Reading took too long. Try a smaller file."); }, 30_000);
      current.postMessage(files);
    } catch { done(); setError("File reading is unavailable. Paste the text instead."); }
  };
  const fill = async () => {
    if (busy || reading) return;
    setError(""); setMessage("");
    const controller = new AbortController();
    const base = latest.current.profile;
    let applied = 0, skipped = 0;
    const fields: ContextField[] = [];
    try {
      const sources = [...documents, ...(text.trim() ? [{ name: "Pasted context", text: text.trim() }] : [])];
      validateContextDocuments(sources);
      const website = normalizeContextWebsite(base.website || "");
      if (!discoverContext && !sources.length && !website) throw new Error("Add text, files, or a company website.");
      request.current = controller; setBusy(true); onFields([]);
      await fillContext({ documents: sources, website, profile: base, signal: controller.signal,
        onActivity: (activity) => { if (!controller.signal.aborted) setMessage(activity); },
        onField: (result) => {
          if (controller.signal.aborted) return;
          const next = mergeContextUpdate(base, latest.current.profile, result);
          if (!next) { skipped++; return; }
          latest.current = { ...latest.current, profile: next };
          latest.current.update(next); applied++; fields.push(result.field); onFields([...fields]);
          setMessage(`Added ${CONTEXT_LABELS[result.field].toLowerCase()}`);
        },
      });
      if (!controller.signal.aborted) setMessage(`${applied} section${applied === 1 ? "" : "s"} filled.${skipped ? " Your edits were kept." : ""}`);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not fill context. Try again.");
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  };
  return <section className={styles.contextComposer} aria-label="Add context"
    onDragOver={(event) => { event.preventDefault(); }}
    onDrop={(event) => { event.preventDefault(); readFiles(Array.from(event.dataTransfer.files)); }}>
    <label className={styles.contextWebsite}><span>Company website</span><input aria-label="Company website" value={profile.website || ""} onChange={(event) => update({ ...profile, website: event.target.value })} placeholder="company.com" autoComplete="url" maxLength={253} disabled={busy} /></label>
    <textarea aria-label="Paste context" placeholder={discoverContext ? "Add notes or files, or let Screenpipe learn from your work history and connections…" : "Paste notes about your work, or drop documents here…"} value={text} onChange={(event) => setText(event.target.value)} maxLength={MAX_CONTEXT_SOURCE_TEXT} disabled={busy || reading} />
    {documents.length > 0 && <div className={styles.contextAttachments}>{documents.map((document, index) => <span key={`${index}:${document.name}`}>{document.name}<button aria-label={`Remove ${document.name}`} onClick={() => setDocuments(documents.filter((_, i) => i !== index))} disabled={busy || reading}><X size={12} /></button></span>)}</div>}
    <div className={styles.contextToolbar}>
      <input ref={input} type="file" multiple accept=".pdf,.txt,.md,.markdown,.csv,.json,.zip" hidden onChange={(event) => { readFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
      <button type="button" onClick={() => input.current?.click()} disabled={busy || reading}><Paperclip size={15} />{reading ? "Reading files…" : "Add files or ZIP"}</button>
      {busy ? <button type="button" onClick={() => { request.current?.abort(); setMessage("Stopped. Filled fields were kept."); }}><Square size={13} />Stop</button> : <button className={styles.contextFillButton} type="button" onClick={() => void fill()} disabled={reading || (!discoverContext && !text.trim() && !documents.length && !profile.website?.trim())}><ArrowUp size={15} />Fill context</button>}
    </div>
    {(message || error || warnings.length > 0) && <div className={styles.contextStatus} role={error ? "alert" : "status"}>{error || message}{warnings.length > 0 && <details><summary>{warnings.length} file notice{warnings.length === 1 ? "" : "s"}</summary>{warnings.map((warning) => <p key={warning}>{warning}</p>)}</details>}</div>}
  </section>;
}
