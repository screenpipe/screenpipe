// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import type { WorkflowAnalysis, WorkflowMap, WorkflowStage } from "./model";

export type ProcedureEdit = {
  sourceIndex: number | null;
  kind: NonNullable<WorkflowStage["procedure"]>[number]["kind"];
  text: string;
};
export type StageEdit = {
  sourceIndex: number | null;
  name: string;
  description: string;
  procedure: ProcedureEdit[];
};
export type WorkflowEdit = {
  id: string;
  expected_revision: number;
  title: string;
  description: string;
  trigger: string;
  outcome: string;
  stages: StageEdit[];
};
export function workflowEdit(workflow: WorkflowMap): WorkflowEdit {
  return {
    id: workflow.id ?? workflow.title,
    expected_revision: workflow.revision ?? 0,
    title: workflow.title,
    description: workflow.description,
    trigger: workflow.trigger,
    outcome: workflow.outcome,
    stages: workflow.stages.map((stage, sourceIndex) => ({
      sourceIndex,
      name: stage.name,
      description: stage.description,
      procedure: (stage.procedure ?? []).map(({ kind, text }, sourceIndex) => ({
        sourceIndex,
        kind,
        text,
      })),
    })),
  };
}
export function moveBlock<T>(items: T[], from: number, to: number): T[] {
  if (
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length ||
    from === to
  )
    return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
export function validWorkflowEdit(
  draft: WorkflowEdit,
  allowIncomplete = false,
): boolean {
  const text = (s: unknown, required = false) =>
    typeof s === "string" &&
    new TextEncoder().encode(s).length <= 8000 &&
    (allowIncomplete || !required || !!s.trim());
  return (
    !!draft &&
    typeof draft.id === "string" &&
    Number.isInteger(draft.expected_revision) &&
    draft.expected_revision >= 0 &&
    text(draft.title, true) &&
    [draft.description, draft.trigger, draft.outcome].every((s) => text(s)) &&
    Array.isArray(draft.stages) &&
    draft.stages.length > 0 &&
    draft.stages.length <= 100 &&
    draft.stages.every(
      (s) =>
        text(s.name, true) &&
        text(s.description) &&
        Array.isArray(s.procedure) &&
        s.procedure.length <= 100 &&
        s.procedure.every(
          (p) =>
            text(p.text, true) &&
            ["action", "input", "output", "decision", "check"].includes(p.kind),
        ),
    )
  );
}

/** A read already in flight must not roll back a more recently saved edit. */
export function retainNewerWorkflowEdits(
  current: WorkflowAnalysis | null,
  incoming: WorkflowAnalysis,
): WorkflowAnalysis {
  if (!current || current.scope?.id !== incoming.scope?.id) return incoming;
  return {
    ...incoming,
    analysis: {
      ...incoming.analysis,
      workflows: incoming.analysis.workflows.map((next) => {
        const previous = current.analysis.workflows.find(
          (w) => w.id && w.id === next.id,
        );
        return previous?.userEditedAt &&
          (previous.revision ?? 0) > (next.revision ?? 0)
          ? previous
          : next;
      }),
    },
  };
}
