// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import type { WorkflowTiming, WorkflowTimingRun } from "./model";

/** Derive display values from validated source boundaries, never model totals. */
export function workflowTiming(value: unknown): WorkflowTiming | null {
  const timing = value as WorkflowTiming | null;
  if (timing?.basis !== "estimated-elapsed" || !Array.isArray(timing.runs) || !timing.runs.length || timing.runs.length > 30) return null;
  const boundary = (point: WorkflowTimingRun["start"]) => point && typeof point.timestamp === "string" && Number.isFinite(Date.parse(point.timestamp))
    && typeof point.app === "string" && point.app.trim() && typeof point.quote === "string" && point.quote.trim().length >= 12 && point.quote.length <= 1200;
  if (timing.runs.some(run => !run || !boundary(run.start) || !boundary(run.end)
    || typeof run.summary !== "string" || !run.summary.trim() || Date.parse(run.end.timestamp) <= Date.parse(run.start.timestamp))) return null;
  const runs = [...timing.runs].sort((a, b) => Date.parse(a.start.timestamp) - Date.parse(b.start.timestamp));
  if (runs.some((run, i) => i > 0 && Date.parse(run.start.timestamp) < Date.parse(runs[i - 1].end.timestamp))) return null;
  const minutes = runs.map(run => (Date.parse(run.end.timestamp) - Date.parse(run.start.timestamp)) / 60_000);
  return { basis: "estimated-elapsed", runs, sampleCount: runs.length,
    averageMinutes: minutes.reduce((sum, value) => sum + value, 0) / minutes.length,
    minMinutes: Math.min(...minutes), maxMinutes: Math.max(...minutes) };
}
