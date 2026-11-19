// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useMemo } from "react";
import { Braces, ChevronLeft, ChevronRight, GitBranch, ListOrdered, PanelsTopLeft } from "lucide-react";
import styles from "./workflow-editor.module.css";
import { ProcedureFlowchart } from "./workflow-map";
import type { ProcedureMapLayout } from "./workflow-map-layout";
import type { MapStage } from "./workflow-map-model";

export type WorkflowReadingView = "walkthrough" | "map" | "steps";
export type WorkflowMapRoute = {
  condition?: string;
  kind?: MapStage["kind"];
  app?: string;
  links: { label: string; description?: string; target: number | "end" | null }[];
};
export function WorkflowReadingControls({ view, change, variables, showMap = true }: {
  view: WorkflowReadingView; change: (view: WorkflowReadingView) => void;
  showMap?: boolean;
  variables?: { open: boolean; toggle: () => void };
}) {
  return <div className={styles.stepsHeading}>
    <span className={styles.workflowTab}>Workflow</span>
    <div className={styles.viewTools}>
      <div role="group" aria-label="Workflow view" className={styles.viewSwitch}>
        {([{ value: "walkthrough", label: "Walkthrough", icon: PanelsTopLeft }, { value: "map", label: "Map", icon: GitBranch }, { value: "steps", label: "Steps", icon: ListOrdered }] as const).filter(mode => showMap || mode.value !== "map").map(({ value, label, icon: Icon }) => <button key={value} type="button" aria-label={label} title={label} aria-pressed={view === value} onClick={() => change(value)}><Icon size={16} aria-hidden="true" /><span hidden={view !== value}>{label}</span></button>)}
      </div>
      {variables && <button type="button" aria-label="Variables" title="Variables" aria-expanded={variables.open} onClick={variables.toggle}><Braces size={16} /></button>}
    </div>
  </div>;
}
export function WorkflowReadingMap({ steps, selected, choose, routes, layout, changeLayout }: {
  steps: { name: string; apps?: string[] }[]; selected: number; choose: (index: number) => void; routes?: WorkflowMapRoute[];
  layout: ProcedureMapLayout; changeLayout: (layout: ProcedureMapLayout) => void;
}) {
  const stages = useMemo<MapStage[]>(() => steps.map((step, index) => {
    const route = routes?.[index];
    const target = (value: number | "end" | null) => value === null ? undefined : value === "end" ? "end" : `step-${value}`;
    const decision = route?.kind === "decision" || route?.links.some(link => link.label === "Yes" || link.label === "No");
    return {
      key: `step-${index}`, stepId: `step-${index}`, title: step.name || "Untitled step",
      kind: route?.kind ?? (decision ? "decision" : "action"), app: route?.app ?? step.apps?.[0],
      ...(decision ? { decision: {
        condition: route?.condition || "", if_yes: route?.links[0]?.description || "Destination not set", if_no: route?.links[1]?.description || "Destination not set",
        yes_step_id: target(route?.links[0]?.target ?? null), no_step_id: target(route?.links[1]?.target ?? null),
      } } : route ? { nextStepId: target(route.links[0]?.target ?? null) ?? "unmapped" } : {}),
    };
  }), [steps, routes]);
  return <ProcedureFlowchart stages={stages} selected={`step-${selected}`} onSelect={key => {
    const index = stages.findIndex(stage => stage.key === key);
    if (index >= 0) choose(index);
  }} layout={layout} onLayoutChange={changeLayout} />;
}
export function WorkflowReadingNavigation({ index, count, choose }: { index: number; count: number; choose: (index: number) => void }) {
  return <nav aria-label="Walkthrough navigation" className={styles.walkthroughNavigation}>
    <button type="button" disabled={index === 0} onClick={() => choose(index - 1)}><ChevronLeft size={16} />Previous</button>
    <span>{index + 1} / {count}</span>
    <button type="button" disabled={index === count - 1} onClick={() => choose(index + 1)}>Next<ChevronRight size={16} /></button>
  </nav>;
}
