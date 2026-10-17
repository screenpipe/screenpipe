// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { validVariables } from "./workflow-variables";
import type { WorkflowAnalysis, WorkflowMap, WorkflowStage, WorkflowVariable } from "./model";

export type ProcedureEdit = {
  id?: string;
  sourceIndex: number | null;
  kind: NonNullable<WorkflowStage["procedure"]>[number]["kind"];
  text: string;
};
export type StageEdit = {
  id?: string;
  requiredAccess?: string;
  exceptions?: string;
  escalation?: string;
  responseTemplate?: string;
  linkedWorkflowId?: string;
  sourceIndex: number | null;
  imageLayout?: WorkflowStage["imageLayout"];
  name: string;
  description: string;
  procedure: ProcedureEdit[];
};
export type WorkflowEdit = {
  variables?: WorkflowVariable[];
  archived?: boolean;
  reviewStatus?: WorkflowMap["reviewStatus"];
  reviewNote?: string;
  restoreRevision?: number;
  id: string;
  expected_revision: number;
  title: string;
  description: string;
  trigger: string;
  outcome: string;
  stages: StageEdit[];
};
/** Match authored content to the referenced step before reusing its timing. */
export function isUnchangedStage(edit: StageEdit, source: WorkflowStage | undefined): boolean {
  return Boolean(source && edit.name.trim() === source.name && edit.description.trim() === source.description
    && ["requiredAccess", "exceptions", "escalation", "responseTemplate", "linkedWorkflowId"].every(key => (edit[key as keyof StageEdit] ?? "") === (source[key as keyof WorkflowStage] ?? ""))
    && edit.procedure.length === (source.procedure?.length ?? 0)
    && edit.procedure.every((block, index) => block.sourceIndex === index
      && block.kind === source.procedure![index].kind && block.text.trim() === source.procedure![index].text));
}

function availableId(used: Set<string>, fallback: string) {
  let id = fallback, suffix = 1;
  while (used.has(id)) id = `${fallback}-${suffix++}`;
  used.add(id); return id;
}
export function workflowEdit(workflow: WorkflowMap): WorkflowEdit {
  const stepIds = new Set(workflow.stages.flatMap(s=>s.id ? [s.id] : []));
  return {
    id: workflow.id ?? workflow.title,
    expected_revision: workflow.revision ?? 0,
    ...(workflow.variables ? { variables: workflow.variables } : {}),
    ...(workflow.archived !== undefined ? { archived: workflow.archived } : {}),
    ...(workflow.reviewStatus ? { reviewStatus: workflow.reviewStatus } : {}),
    ...(workflow.reviewNote !== undefined ? { reviewNote: workflow.reviewNote } : {}),
    title: workflow.title,
    description: workflow.description,
    trigger: workflow.trigger,
    outcome: workflow.outcome,
    stages: workflow.stages.map((stage, sourceIndex) => ({
      id: stage.id ?? availableId(stepIds,`step-${sourceIndex}`),
      ...Object.fromEntries(["requiredAccess", "exceptions", "escalation", "responseTemplate", "linkedWorkflowId"].filter(key => key in stage).map(key => [key, stage[key as keyof WorkflowStage]])),
      sourceIndex,
      name: stage.name,
      description: stage.description,
      ...(stage.imageLayout ? { imageLayout: stage.imageLayout } : {}),
      procedure: (()=>{
        const ids = new Set((stage.procedure ?? []).flatMap(p=>p.id ? [p.id] : []));
        return (stage.procedure ?? []).map(({id,kind,text},sourceIndex)=>({id:id ?? availableId(ids,`block-${sourceIndex}`),sourceIndex,kind,text}));
      })(),
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
    (draft.variables === undefined || validVariables(draft.variables)) &&
    (draft.archived === undefined || typeof draft.archived === "boolean") &&
    (draft.reviewStatus === undefined || ["needs-review","needs-edits","reviewed"].includes(draft.reviewStatus)) &&
    (draft.reviewNote === undefined || text(draft.reviewNote)) &&
    text(draft.title, true) &&
    [draft.description, draft.trigger, draft.outcome].every((s) => text(s)) &&
    Array.isArray(draft.stages) &&
    draft.stages.length > 0 &&
    draft.stages.length <= 100 &&
    draft.stages.every(
      (s) =>
        text(s.name, true) &&
        text(s.description) &&
        [s.requiredAccess,s.exceptions,s.escalation,s.responseTemplate,s.linkedWorkflowId].every(v => v === undefined || text(v)) &&
        (!s.imageLayout || (typeof s.imageLayout.beforeText === "boolean" && [s.imageLayout.order, s.imageLayout.hidden].every(ids => Array.isArray(ids) && ids.length <= 100 && new Set(ids).size === ids.length && ids.every(id => Number.isSafeInteger(id) && id >= 0)))) &&
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
