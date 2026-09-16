// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Circle, Loader2, RefreshCw, Square, AlertCircle } from "lucide-react";
import type { WorkflowAnalysisJob, WorkflowRunActivity, WorkflowsPlatform } from "./platform";
import styles from "./workflows-app.module.css";

export function WorkflowRunProgress({ job, active, subscribe, stop, analyze, updatedAt, changes, disabledReason }: {
  disabledReason?: string;
  job?: WorkflowAnalysisJob | null; active: boolean;
  subscribe?: WorkflowsPlatform["subscribeAnalysisActivity"];
  stop?: () => void; analyze: () => void; updatedAt?: string;
  changes?: { created: number; updated: number };
}) {
  const [activity, setActivity] = useState<{ jobId: string; items: WorkflowRunActivity[] }>({ jobId: "", items: [] });
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); toggle.current?.focus(); } };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [open]);
  const [now, setNow] = useState(Date.now);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => { setOpen(false); setActivity({ jobId: job?.id ?? "", items: [] }); }, [job?.id]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => {
    if (!active || !job?.id || !subscribe) return;
    let disposed = false;
    let off: (() => void) | undefined;
    setUnavailable(false);
    void subscribe(job.id, items => { if (!disposed) setActivity({ jobId: job.id, items }); })
      .then(cleanup => { if (disposed) cleanup(); else off = cleanup; })
      .catch(() => { if (!disposed) setUnavailable(true); });
    return () => { disposed = true; off?.(); };
  }, [active, job?.id, subscribe]);
  const items = activity.jobId === job?.id ? activity.items : [];
  const current = [...items].reverse().find(item => item.status === "running") ?? items.at(-1);
  const seconds = job?.startedAt ? Math.max(0, Math.floor((now - Date.parse(job.startedAt)) / 1000)) : NaN;
  const result = changes ? changes.created === 0 && changes.updated === 0 ? "Up to date" : `${changes.created} new · ${changes.updated} updated` : "Workflows updated";
  const label = active ? current?.label ?? (job?.message || (job?.status === "queued" ? "Waiting for agent" : "Agent working"))
    : job?.status === "incomplete" ? "Update incomplete" : job?.status === "failed" ? "Update failed" : job?.status === "complete" ? result
    : updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
  return <div className={styles.refreshControls}>
    {(active || items.length > 0) ? <div ref={root} className={styles.runProgress}>
      <button ref={toggle} type="button" className={styles.runToggle} aria-expanded={open} aria-label={`${label}. Show agent activity`} onClick={() => setOpen(!open)}>
        {active ? <Loader2 size={14} className={styles.runSpinner} /> : job?.status === "failed" ? <AlertCircle size={14} /> : job?.status === "incomplete" ? <Circle size={14} /> : <Check size={14} />}
        <span role="status">{label}</span>
        {active && Number.isFinite(seconds) && <time>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</time>}
        <ChevronDown size={12} style={{ transform: open ? "rotate(180deg)" : undefined }} />
      </button>
      {open && <section className={styles.runActivity} aria-label="Agent activity">
        <header><strong>{active ? "Updating workflows" : "Workflow update"}</strong><span>{active ? "Live activity" : "Recent activity"}</span></header>
        {items.length ? <ol>{items.map(item => <li key={item.id}>
          {item.status === "error" ? <AlertCircle size={13} /> : item.status === "complete" ? <Check size={13} /> : active ? <Loader2 size={13} className={styles.runSpinner} /> : <Circle size={13} />}
          <span>{item.label}{!active && item.status === "running" ? " · ended" : ""}</span>
        </li>)}</ol> : <p>{unavailable ? "Live activity is unavailable. The task status will keep updating." : "Waiting for the next agent action…"}</p>}
        <footer>{active ? "Your saved workflows stay available." : (job?.status === "failed" || job?.status === "incomplete") ? job.message : result}</footer>
      </section>}
    </div> : <span role="status">{label}</span>}
    {active && stop ? <button className={styles.secondaryButton} onClick={stop}><Square size={11} />Stop</button>
      : <button className={styles.secondaryButton} onClick={analyze} disabled={active || !!disabledReason} title={disabledReason}><RefreshCw size={14} />{job?.status === "incomplete" ? "Resume update" : "Update now"}</button>}
  </div>;
}
