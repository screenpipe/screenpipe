// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Circle, Loader2, RefreshCw, Square, AlertCircle } from "lucide-react";
import type { WorkflowAnalysisJob, WorkflowsPlatform } from "./platform";
import { useWorkflowRunActivity, type WorkflowActivityState } from "./use-workflow-run-activity";
import styles from "./workflows-app.module.css";
import { useGT } from "gt-react";


export function WorkflowRunProgress({ job, active, subscribe, stop, analyze, updatedAt, checkedThrough, changes, disabledReason, quiet = false, actions, activityState }: {
  activityState?: WorkflowActivityState;
  quiet?: boolean; actions?: ReactNode;
  disabledReason?: string;
  job?: WorkflowAnalysisJob | null; active: boolean;
  subscribe?: WorkflowsPlatform["subscribeAnalysisActivity"];
  stop?: () => void; analyze: () => void; updatedAt?: string; checkedThrough?: string;
  changes?: { created: number; updated: number };
}) {
  const ui = useGT();
  const observed = useWorkflowRunActivity(job, active && !activityState, activityState ? undefined : subscribe);
  const activity = activityState ?? observed;
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
  useEffect(() => { setOpen(false); }, [activity.cycleId]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const { items, unavailable } = activity;
  const current = [...items].reverse().find(item => item.status === "running");
  const seconds = job?.startedAt ? Math.max(0, Math.floor((now - Date.parse(job.startedAt)) / 1000)) : NaN;
  changes = job?.result?.changes ?? changes;
  checkedThrough = job?.result?.checkedThrough ?? checkedThrough;
  const reviewed = checkedThrough && Number.isFinite(Date.parse(checkedThrough)) ? new Date(checkedThrough).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : undefined;
  const result = changes ? changes.created === 0 && changes.updated === 0 ? "No changes found" : `${changes.created} new · ${changes.updated} updated` : "Workflows updated";
  const label = active ? current?.label ?? (job?.status === "queued" ? "Waiting to start" : "Updating workflows")
    : job?.status === "incomplete" ? "Update incomplete" : job?.status === "failed" ? "Update failed" : job?.status === "complete" ? result
    : updatedAt ? result : "";
  const receipt = quiet && !active && reviewed && job?.status !== "failed" && job?.status !== "incomplete"
    ? ui("Reviewed through {date}", { date: reviewed }) : label;
  const actionLabel = active && stop ? ui("Stop") : job?.status === "incomplete" ? ui("Resume update") : ui("Update now");
  return <div className={quiet ? styles.quietRefreshControls : styles.refreshControls}>
    {(active || items.length > 0 || job || updatedAt) ? <div ref={root} className={styles.runProgress}>
      <button ref={toggle} type="button" className={styles.runToggle} aria-expanded={open} aria-label={ui("{value1}. Show agent activity", { value1: label })} onClick={() => setOpen(!open)}>
        {active ? <Loader2 size={14} className={styles.runSpinner} /> : job?.status === "failed" ? <AlertCircle size={14} /> : job?.status === "incomplete" ? <Circle size={14} /> : <Check size={14} />}
        <span role="status">{receipt}{!quiet && !active && reviewed && <small style={{ display: "block" }}>Through {reviewed}</small>}</span>
        {active && Number.isFinite(seconds) && <time>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</time>}
        <ChevronDown size={12} style={{ transform: open ? "rotate(180deg)" : undefined }} />
      </button>
      {open && <section className={styles.runActivity} aria-label={ui("Agent activity")}>
        <header><strong>{active ? ui("Updating workflows") : ui("Workflow update")}</strong><span>{active ? ui("Live activity") : ui("Recent activity")}</span></header>
        {reviewed && !active && <p>Data reviewed through <time dateTime={checkedThrough}>{reviewed}</time></p>}
        {items.length ? <ol>{items.map(item => <li key={item.id}>
          {item.status === "error" ? <AlertCircle size={13} /> : item.status === "complete" ? <Check size={13} /> : active ? <Loader2 size={13} className={styles.runSpinner} /> : <Circle size={13} />}
          <span>{item.label}{!active && item.status === "running" ? ui(" · ended") : ""}</span>
        </li>)}</ol> : active ? <p>{unavailable ? ui("Live activity is unavailable. The task status will keep updating.") : ui("The update is continuing. New activity will appear here.")}</p> : null}
        <footer>{active ? ui("Your saved workflows stay available.") : (job?.status === "failed" || job?.status === "incomplete") ? job.message : result}</footer>
      </section>}
    </div> : <span role="status">{label}</span>}
    <div className={quiet ? styles.quietHeaderActions : styles.runActions}>
      {actions}
      {active && stop ? <button className={quiet ? styles.quietIconButton : styles.secondaryButton} onClick={stop} aria-label={actionLabel} title={actionLabel}><Square size={16} />{!quiet && actionLabel}</button>
        : <button className={quiet ? styles.quietIconButton : styles.secondaryButton} onClick={analyze} disabled={active || !!disabledReason} aria-label={actionLabel} title={disabledReason || actionLabel}><RefreshCw size={16} />{!quiet && actionLabel}</button>}
    </div>
  </div>;
}
