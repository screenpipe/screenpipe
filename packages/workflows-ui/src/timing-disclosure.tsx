// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Clock3 } from "lucide-react";
import { workflowTiming, formatTimingMinutes } from "./timing";
import styles from "./timing-disclosure.module.css";

/** Lightweight, local disclosure: no requests, timers or per-row document listeners. */
export function TimingDisclosure({ value, label, measured }: {
  value: unknown;
  label: string;
  measured?: { minutes: number; samples: number };
}) {
  const timing = workflowTiming(value);
  const recording = !timing && measured && Number.isFinite(measured.minutes) && measured.minutes > 0 && measured.samples >= 2 ? measured : null;
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const [pinned, setPinned] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const id = useId();
  const show = () => {
    const bounds = root.current?.getBoundingClientRect();
    setAbove(Boolean(bounds && bounds.bottom + 150 > window.innerHeight && bounds.top > 150));
    setOpen(true);
  };
  const close = () => { setOpen(false); setPinned(false); };
  useEffect(() => {
    if (!pinned) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) { setOpen(false); setPinned(false); }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [pinned]);
  return <span ref={root} className={styles.root}
    onMouseEnter={show} onMouseLeave={() => { if (!pinned && !root.current?.contains(document.activeElement)) setOpen(false); }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) close(); }}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
    <button type="button" className={styles.trigger} aria-label={label}
      aria-expanded={open} aria-controls={open ? id : undefined} aria-describedby={open ? id : undefined}
      onFocus={show} onClick={() => { if (pinned) close(); else { show(); setPinned(true); } }}>
      <Clock3 size={15} aria-hidden="true" />
    </button>
    {open && <span className={styles.anchor} data-above={above || undefined}><span id={id} role="tooltip" className={styles.content}>
      {timing ? <>
        <strong>{formatTimingMinutes(timing.averageMinutes)} {timing.sampleCount > 1 ? "on average" : "for one run"}</strong>
        <span>{timing.sampleCount === 1 ? "1 observed run" : `${timing.sampleCount} observed runs · ${formatTimingMinutes(timing.minMinutes)} to ${formatTimingMinutes(timing.maxMinutes)}`}</span>
        <small>Estimated elapsed time, including pauses. Not active work time.</small>
      </> : recording ? <>
        <strong>{formatTimingMinutes(recording.minutes)} median duration</strong>
        <span>{recording.samples} recorded meetings</span>
        <small>Meeting duration only.</small>
      </> : <>
        <strong>Time not measured yet</strong>
        <span>A complete start and finish are needed to estimate this duration.</span>
      </>}
    </span></span>}
  </span>;
}
