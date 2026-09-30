// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { useEffect, useRef, useState } from "react";
import type { WorkflowAnalysisJob, WorkflowRunActivity, WorkflowsPlatform } from "./platform";

export type WorkflowActivityState = { cycleId: string; items: WorkflowRunActivity[]; unavailable: boolean };
type Listener = { live: boolean; off?: () => void; snapshot: Map<string, WorkflowRunActivity> };

/** Owned by the app, so navigating away from the list does not lose activity. */
export function useWorkflowRunActivity(job: WorkflowAnalysisJob | null | undefined, enabled: boolean, subscribe?: WorkflowsPlatform["subscribeAnalysisActivity"]) {
  const cycleId = job?.cycleId ?? job?.id ?? "";
  const [state, setState] = useState<WorkflowActivityState>({ cycleId: "", items: [], unavailable: false });
  const scope = useRef<{ live: boolean; listeners: Map<string, Listener> }>();
  useEffect(() => {
    const current = { live: true, listeners: new Map<string, Listener>() };
    scope.current = current;
    setState(previous => previous.cycleId === cycleId ? previous : { cycleId, items: [], unavailable: false });
    return () => {
      current.live = false;
      for (const listener of current.listeners.values()) { listener.live = false; listener.off?.(); }
    };
  }, [cycleId, subscribe, enabled]);

  useEffect(() => {
    const current = scope.current;
    const executionId = job?.id;
    if (!enabled || !executionId || !subscribe || !current || current.listeners.has(executionId)) return;
    const listener: Listener = { live: true, snapshot: new Map() };
    current.listeners.set(executionId, listener);
    // Retain the recent feed, with bounded observers even for long update cycles.
    while (current.listeners.size > 20) {
      const oldest = current.listeners.keys().next().value!;
      const removed = current.listeners.get(oldest)!;
      removed.live = false; removed.off?.(); current.listeners.delete(oldest);
    }
    void subscribe(executionId, incoming => {
      if (!current.live || !listener.live) return;
      const previousSnapshot = listener.snapshot;
      listener.snapshot = new Map(incoming.slice(-20).map(item => [item.id, item]));
      const changed = [...listener.snapshot.values()].filter(item => {
        const before = previousSnapshot.get(item.id);
        return !before || before.status !== item.status || before.label !== item.label;
      });
      setState(previous => {
        const items = new Map((previous.cycleId === cycleId ? previous.items : []).map(item => [item.id, item]));
        for (const item of changed) {
          const id = `${executionId}:${item.id}`;
          const prior = items.get(id);
          // Repeated full snapshots must not reinsert older, already-trimmed rows.
          if (!prior && previousSnapshot.has(item.id) && item.status !== "error") continue;
          // A reconnected stream may replay a start after its completion.
          if (prior && prior.status !== "running" && item.status === "running") continue;
          items.set(id, { ...item, id });
        }
        return { cycleId, items: [...items.values()].slice(-20), unavailable: false };
      });
    }).then(off => { if (!current.live || !listener.live) off(); else listener.off = off; })
      .catch(() => { if (current.live && listener.live) setState(previous => ({ ...previous, unavailable: true })); });
  }, [cycleId, job?.id, enabled, subscribe]);

  return state.cycleId === cycleId ? state : { cycleId, items: [], unavailable: false };
}
