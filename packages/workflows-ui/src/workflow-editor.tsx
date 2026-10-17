// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  ChevronDown,
  Plus,
  Trash2,
  Undo2,
  Braces,
  History,
  Info,
} from "lucide-react";
import type { WorkflowMap, WorkflowStage } from "./model";
import {
  moveBlock,
  isUnchangedStage,
  validWorkflowEdit,
  workflowEdit,
  type WorkflowEdit,
  type StageEdit,
} from "./workflow-edits";
import { WorkflowRichText } from "./rich-text";
import { InlineText } from "./inline-text";
import { TimingDisclosure } from "./timing-disclosure";
import { WorkflowVariablePanel, type VariableQuote } from "./workflow-variable-panel";
import { WorkflowVersionPanel } from "./workflow-version-panel";
import { executionFields, variableId } from "./workflow-variables";
import styles from "./workflow-editor.module.css";

function Text(props: Parameters<typeof InlineText>[0] & { title?: boolean }) {
  return <InlineText {...props} className={props.title ? styles.title : undefined} />;
}

type EditorStage = Omit<StageEdit, "procedure"> & { key: string; procedure: (StageEdit["procedure"][number] & { key: string })[] };
type EditorDraft = Omit<WorkflowEdit, "stages"> & { stages: EditorStage[] };
function keyedDraft(draft: WorkflowEdit): EditorDraft {
  return { ...draft, stages: draft.stages.map(stage => ({ ...stage, key: (stage as EditorStage).key || crypto.randomUUID(), procedure: stage.procedure.map(block => ({ ...block, key: (block as EditorStage["procedure"][number]).key || crypto.randomUUID() })) })) };
}
function payload(draft: EditorDraft): WorkflowEdit {
  return { ...draft, stages: draft.stages.map(({ key, procedure, ...stage }) => ({ ...stage, procedure: procedure.map(({ key, ...block }) => block) })) };
}
// Keep local identities while source positions change after each saved reorder.
function rebase(draft: EditorDraft, sent: EditorDraft, saved: WorkflowMap): EditorDraft {
  return { ...draft, id: saved.id ?? sent.id, expected_revision: saved.revision ?? 0, stages: draft.stages.map(stage => {
    const index = sent.stages.findIndex(s => s.key === stage.key);
    return { ...stage, sourceIndex: index < 0 ? null : index, procedure: stage.procedure.map(block => {
      const blockIndex = index < 0 ? -1 : sent.stages[index].procedure.findIndex(p => p.key === block.key);
      return { ...block, sourceIndex: blockIndex < 0 ? null : blockIndex };
    }) };
  }) };
}

export type WorkflowEditorOptions = {
  relatedWorkflows?: WorkflowMap[];
  openRelated?: (id: string) => void;
  stepsOnly?: boolean;
  /** Canonical cloud steps have one expected-result field. */
  singleCheck?: boolean;
  initialDraft?: WorkflowEdit;
  onDraftChange?: (draft: WorkflowEdit) => void;
  sessionRecovery?: boolean;
  saveDisabled?: boolean;
};
export function WorkflowEditor({ workflow, save, actions, renderSource, relatedWorkflows = [], openRelated, stepsOnly = false, singleCheck = false, initialDraft, onDraftChange, sessionRecovery = true, saveDisabled = false }: WorkflowEditorOptions & {
  workflow: WorkflowMap;
  save: (draft: WorkflowEdit) => Promise<WorkflowMap>;
  actions?: ReactNode;
  renderSource?: (stage: WorkflowStage, onImageLayoutChange?: (layout: NonNullable<WorkflowStage["imageLayout"]>) => void) => ReactNode;
}) {
  const key = `screenpipe:workflow-edit:${workflow.id ?? workflow.title}`;
  const [initial, setInitial] = useState(() => keyedDraft(workflowEdit(workflow)));
  const [draft, setDraft] = useState<EditorDraft>(() => {
    if (initialDraft) return keyedDraft(initialDraft);
    try {
      const saved = sessionRecovery && JSON.parse(sessionStorage.getItem(key) || "null");
      if (saved?.id === initial.id && validWorkflowEdit(saved, true)) return keyedDraft(saved);
    } catch { /* Optional tab-local recovery. */ }
    return initial;
  });
  const unchangedStages = draft.stages.length === workflow.stages.length && draft.stages.every((stage, index) => stage.sourceIndex === index && isUnchangedStage(stage, workflow.stages[index]));
  const [panel, setPanel] = useState<"variables" | "history" | "details" | null>(null);
  useEffect(()=>{
    if(stepsOnly) return;
    const open=(event:Event)=>{const value=(event as CustomEvent).detail;if(["variables","history","details"].includes(value))setPanel(value);};
    window.addEventListener("workflows:document-panel",open);
    return ()=>window.removeEventListener("workflows:document-panel",open);
  },[stepsOnly]);
  const [selectedVariable, setSelectedVariable] = useState("");
  const [quote, setQuote] = useState<VariableQuote>();
  const [executionOpen, setExecutionOpen] = useState<string | null>(null);
  const showVariable = (id: string) => { setSelectedVariable(id); setPanel("variables"); };
  const [history, setHistory] = useState<EditorDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [blockDragOver, setBlockDragOver] = useState<string | null>(null);
  const [stepMenu, setStepMenu] = useState<string | null>(null);
  const stepMenuTrigger = useRef<HTMLButtonElement | null>(null);
  const draggedStep = useRef(false);
  const [blockMenu, setBlockMenu] = useState<string | null>(null);
  const blockMenuTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!blockMenu) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-block-actions]")) setBlockMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); setBlockMenu(null); blockMenuTrigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [blockMenu]);
  const editorRoot = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!stepMenu) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-step-actions]")) setStepMenu(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [stepMenu]);
  function closeStepMenu(restoreFocus = true) {
    setStepMenu(null);
    if (restoreFocus) stepMenuTrigger.current?.focus();
  }
  const dragging = useRef<{ stage: number; detail?: number } | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const current = useRef(draft);
  const baseline = useRef(initial);
  const dirty = JSON.stringify(payload(draft)) !== JSON.stringify(payload(initial));
  const valid = validWorkflowEdit(draft);
  function remember(next: EditorDraft, base = baseline.current) {
    if (!sessionRecovery) return;
    try {
      if (JSON.stringify(payload(next)) !== JSON.stringify(payload(base))) sessionStorage.setItem(key, JSON.stringify(next));
      else sessionStorage.removeItem(key);
    } catch { /* Editing works when storage is unavailable. */ }
  }
  useEffect(() => { remember(draft); }, [draft, initial, key]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const draftCallback = useRef(onDraftChange);
  draftCallback.current = onDraftChange;
  function update(next: EditorDraft) {
    draftCallback.current?.(payload(next));
    current.current = next;
    setDraft(next);
    remember(next);
  }
  function change(next: EditorDraft) {
    const previous = current.current;
    setHistory(h => [...h.slice(-49), previous]);
    update(next);
    setError("");
  }
  function stageChange(index: number, next: EditorStage) {
    change({
      ...draft,
      stages: draft.stages.map((s, i) => (i === index ? next : s)),
    });
  }
  function moveStage(from: number, to: number) {
    const stages = moveBlock(draft.stages, from, to);
    if (stages !== draft.stages) {
      change({ ...draft, stages });
      setAnnouncement(`Step moved to position ${to + 1}`);
    }
  }
  function moveDetail(stage: number, from: number, to: number) {
    const old = draft.stages[stage];
    const procedure = moveBlock(old.procedure, from, to);
    if (old.procedure !== procedure) {
      stageChange(stage, { ...old, procedure });
      setAnnouncement(`Block moved to position ${to + 1}`);
    }
  }
  function addStage(index: number) {
    if (draft.stages.length >= 100) return;
    const stages = [...draft.stages];
    stages.splice(index, 0, { key: crypto.randomUUID(), id: crypto.randomUUID(), sourceIndex: null, name: "", description: "", procedure: [] });
    change({ ...draft, stages });
    closeStepMenu(false);
    focusField(`Step ${index + 1} title`);
  }
  function addDetail(index: number) {
    const stage = draft.stages[index];
    if (stage.procedure.length >= 100 || (singleCheck && stage.procedure.length)) return;
    stageChange(index, { ...stage, procedure: [...stage.procedure,
      { key: crypto.randomUUID(), id: crypto.randomUUID(), sourceIndex: null, kind: singleCheck ? "check" : "action", text: "" }],
    });
    closeStepMenu(false);
    focusField(`Block ${stage.procedure.length + 1} in step ${index + 1}`);
  }
  function insertion(index: number) {
    return <div className={styles.insertion}>
      <button type="button" aria-label={index === 0 ? "Add step at start" : `Add step after ${index}`}
        title="Add step" disabled={draft.stages.length >= 100} onClick={() => addStage(index)}>
        <Plus size={16} aria-hidden="true" />
      </button>
      <span />
    </div>;
  }
  function focusField(label: string) {
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[aria-label="${label}"]`)
        ?.focus(),
    );
  }
  function useLatest() {
    const next = keyedDraft(workflowEdit(workflow));
    baseline.current = next;
    setInitial(next);
    update(next);
    setHistory([]);
    setError("");
  }
  async function submit() {
    const sent = current.current;
    if (saveDisabled || !validWorkflowEdit(sent) || busy.current || JSON.stringify(payload(sent)) === JSON.stringify(payload(baseline.current))) return;
    busy.current = true;
    setSaving(true);
    setError("");
    let succeeded = false;
    try {
      const saved = await save(payload(sent));
      const base = rebase(sent, sent, saved);
      baseline.current = base;
      setInitial(base);
      const next = rebase(current.current, sent, saved);
      update(next);
      setHistory(h => h.map(entry => rebase(entry, sent, saved)));
      setSavedOnce(true);
      succeeded = true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Your changes are kept here.");
    } finally {
      busy.current = false;
      setSaving(false);
      // Finish edits made during a save even if the user has left this page.
      if (succeeded && !mounted.current) void submit();
    }
  }
  useEffect(() => {
    if (dirty || saving || draft.expected_revision === (workflow.revision ?? 0)) return;
    const latest = workflowEdit(workflow);
    if (JSON.stringify({ ...payload(draft), expected_revision: latest.expected_revision }) === JSON.stringify(latest)) {
      // Answer reviews advance the revision without changing the document.
      // Retain block keys so screenshots and playback do not remount or shift scroll.
      const next = { ...draft, expected_revision: latest.expected_revision };
      baseline.current = next; setInitial(next); update(next);
      setHistory(previous => previous.map(entry => ({ ...entry, expected_revision: latest.expected_revision })));
    } else useLatest();
  }, [workflow.revision, dirty, saving]);
  const flush = useRef(submit);
  flush.current = submit;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void flush.current(); };
  }, []);
  useEffect(() => {
    if (!dirty || !valid || saving || error || draft.expected_revision !== (workflow.revision ?? 0)) return;
    const timer = setTimeout(() => void flush.current(), 700);
    return () => clearTimeout(timer);
  }, [draft, dirty, valid, saving, error, workflow.revision]);
  return (
    <section
      ref={editorRoot}
      className={`${styles.editor} ${panel ? styles.withPanel : ""}`}
      onMouseUp={event => {
        const selection = window.getSelection(); const value = selection?.toString().trim();
        if (!value || value.length > 1000 || !event.currentTarget.contains(selection?.anchorNode ?? null) || !event.currentTarget.contains(selection?.focusNode ?? null)) return;
        const element = selection?.anchorNode?.parentElement; const fieldElement = element?.closest<HTMLElement>("[data-variable-field]");
        if (!fieldElement?.contains(selection?.focusNode ?? null)) return;
        const stepId = fieldElement.closest<HTMLElement>("[data-step-id]")?.dataset.stepId;
        if (stepId && fieldElement.dataset.variableField) { setQuote({stepId,field:fieldElement.dataset.variableField,value}); setPanel("variables"); }
      }}
      onClickCapture={event => { const id = variableId((event.target as HTMLElement).closest("a")?.getAttribute("href") ?? ""); if (id) { event.preventDefault(); event.stopPropagation(); showVariable(id); } }}
      onKeyDownCapture={event => { const id = variableId((event.target as HTMLElement).closest("a")?.getAttribute("href") ?? ""); if (id && ["Enter"," "].includes(event.key)) {event.preventDefault();event.stopPropagation();showVariable(id);} }}
      aria-label="Workflow document"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          void submit();
        }
        if (!stepsOnly && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]")) {
          if (e.key.toLowerCase() === "v") setPanel(value => value === "variables" ? null : "variables");
          if (e.key.toLowerCase() === "h") setPanel(value => value === "history" ? null : "history");
          if (e.key === "Escape") setPanel(null);
        }
        // Keep host navigation shortcuts out of editable blocks.
        e.stopPropagation();
      }}
    >
      <header className={styles.toolbar}>
        <div><span role="status" aria-label="Save status">{error ? "Not saved" : saving ? "Saving…" : dirty ? valid ? "Saving…" : "Finish the empty block to save" : savedOnce ? "Saved" : ""}</span></div>
        <div>
          {actions}
          {!stepsOnly && <><button type="button" aria-expanded={panel === "variables"} title="Variables (V)" onClick={()=>setPanel(panel === "variables" ? null : "variables")}><Braces size={16}/>Variables</button>
          <button type="button" aria-expanded={panel === "history"} title="History (H)" onClick={()=>setPanel(panel === "history" ? null : "history")}><History size={16}/>History</button>
          <button type="button" aria-expanded={panel === "details"} onClick={()=>setPanel(panel === "details" ? null : "details")}><Info size={16}/>Details</button></>}
          <button type="button" title="Undo last edit" aria-label="Undo last edit" disabled={!history.length} onClick={() => {
            update(history[history.length - 1]);
            setHistory(h => h.slice(0, -1));
            setError("");
          }}><Undo2 size={17} /></button>
        </div>
      </header>
      {error && (
        <p role="alert" className={styles.error}>
          {error} <button type="button" onClick={() => void submit()} disabled={saving}>Retry save</button>
        </p>
      )}
      {!saving && draft.expected_revision !== (workflow.revision ?? 0) && (
        <p role="alert" className={styles.error}>
          A newer version is available. Your draft is kept.{" "}
          <button
            type="button"
            disabled={saving}
            onClick={useLatest}
          >
            Discard draft and view latest
          </button>
        </p>
      )}
      <div className={styles.documentLayout}>
      <fieldset>
        <div className={styles.intro}>
          <div className={styles.titleRow}>
          {stepsOnly ? <h1 className={styles.title}>{workflow.title}</h1> : <Text title label="Workflow title" value={draft.title} onChange={title => change({ ...draft, title })} />}
          <TimingDisclosure hideWhenUnknown showDuration label="Workflow timing" value={unchangedStages ? workflow.timing : null}
            measured={unchangedStages && workflow.durationSource === "measured-meeting" ? { minutes: workflow.totalMinutes, samples: workflow.durationSampleCount ?? 0 } : undefined} />
          </div>
          {stepsOnly ? <p className={styles.readOnlyText}>{workflow.description}</p> : <Text label="Workflow description" value={draft.description} onChange={description => change({ ...draft, description })} />}
        </div>
        <label className={styles.endpoint}>
          Starts when
          {stepsOnly ? <span className={styles.readOnlyText}>{workflow.trigger}</span> : <Text label="Workflow trigger" value={draft.trigger} onChange={trigger => change({ ...draft, trigger })} />}
        </label>
        <div className={styles.stepsHeading}><strong>Steps</strong></div>
        <div className={styles.steps}>
          {draft.stages.map((stage, index) => (
            <Fragment key={stage.key}>
            {insertion(index)}
            <article
              className={`${styles.step} ${dragOver === index ? styles.drop : ""}`}
              data-step-id={stage.id ?? `step-${index}`}
              aria-label={`Step ${index + 1}`}
              onDragOver={(e) => {
                if (
                  dragging.current?.detail === undefined &&
                  dragging.current
                ) {
                  e.preventDefault();
                  setDragOver(index);
                }
              }}
              onDrop={(e) => {
                if (
                  dragging.current?.detail === undefined &&
                  dragging.current
                ) {
                  e.preventDefault();
                  moveStage(dragging.current.stage, index);
                  dragging.current = null;
                  setDragOver(null);
                }
              }}
            >
              <div className={styles.stepTop}>
                <div data-step-actions data-open={stepMenu === stage.key || undefined} className={styles.stepControls}
                  onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setStepMenu(null); }}
                  onKeyDown={event => {
                    if (event.key === "Escape") {
                      event.preventDefault(); event.stopPropagation(); closeStepMenu();
                    }
                  }}>
                <button
                  type="button"
                  className={styles.grip}
                  draggable
                  title="Click for step actions. Drag or Alt + Up/Down to reorder."
                  aria-label={`Step ${index + 1} actions`}
                  aria-expanded={stepMenu === stage.key}
                  aria-haspopup="dialog"
                  onPointerDown={() => { draggedStep.current = false; }}
                  onClick={event => {
                    if (draggedStep.current) return;
                    stepMenuTrigger.current = event.currentTarget;
                    setStepMenu(stepMenu === stage.key ? null : stage.key);
                    setBlockMenu(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") draggedStep.current = false;
                    if (e.altKey && ["ArrowUp", "ArrowDown"].includes(e.key)) {
                      e.preventDefault();
                      moveStage(index, index + (e.key === "ArrowUp" ? -1 : 1));
                    }
                  }}
                  onDragStart={(e) => {
                    draggedStep.current = true;
                    setStepMenu(null);
                    dragging.current = { stage: index };
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", "workflow-step");
                    e.dataTransfer.setData("application/x-screenpipe-workflow", "step");
                  }}
                  onDragEnd={() => {
                    dragging.current = null;
                    setDragOver(null);
                  }}
                >
                  <GripVertical size={18} />
                </button>
                {stepMenu === stage.key && <div className={styles.stepMenu} role="dialog" aria-label={`Actions for step ${index + 1}`}>
                  <button type="button" disabled={draft.stages.length >= 100} onClick={() => addStage(index + 1)}><Plus size={15} />Add step below</button>
                  {(!singleCheck || !stage.procedure.length) && <button type="button" disabled={stage.procedure.length >= 100} onClick={() => addDetail(index)}><Plus size={15} />{singleCheck ? "Add expected result" : "Add block"}</button>}
                  {!stepsOnly && <button type="button" onClick={()=>{setExecutionOpen(stage.key);closeStepMenu(false);}}>Execution details and links</button>}
                  <button type="button" aria-label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => { closeStepMenu(); moveStage(index, index - 1); }}><ArrowUp size={15} />Move up</button>
                  <button type="button" aria-label={`Move step ${index + 1} down`} disabled={index === draft.stages.length - 1} onClick={() => { closeStepMenu(); moveStage(index, index + 1); }}><ArrowDown size={15} />Move down</button>
                  <button type="button" aria-label={`Delete step ${index + 1}`} disabled={draft.stages.length === 1} onClick={() => {
                    closeStepMenu(false);
                    change({ ...draft, stages: draft.stages.filter((_, i) => i !== index) });
                    focusField(`Step ${Math.min(index + 1, draft.stages.length - 1)} title`);
                  }}><Trash2 size={15} />Delete step</button>
                </div>}
                </div>
                <span className={styles.number}>
                  {String(index + 1).padStart(2, "0")}
                </span>
              <Text
                title
                label={`Step ${index + 1} title`}
                value={stage.name}
                onChange={(name) => stageChange(index, { ...stage, name })}
              />
                <div className={styles.stepActions}>
                <TimingDisclosure hideWhenUnknown showDuration label={`Timing for step ${index + 1}`} value={stage.sourceIndex !== null &&
                  isUnchangedStage(stage, workflow.stages[stage.sourceIndex])
                    ? workflow.stages[stage.sourceIndex]?.timing : null} />
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column" }}>
              <div data-variable-field="description"><Text
                rich
                label={`Step ${index + 1} description`}
                value={stage.description}
                onChange={(description) =>
                  stageChange(index, { ...stage, description })
                }
              />
              </div>
              <div className={styles.blocks}>
                {stage.procedure.map((detail, detailIndex) => (
                  <div
                    className={`${styles.block} ${blockDragOver === `${index}:${detailIndex}` ? styles.blockDrop : ""}`}
                    data-variable-field={`block/${detail.id ?? `block-${detailIndex}`}`}
                    key={detail.key}
                    onDragOver={(e) => {
                      if (
                        dragging.current?.stage === index &&
                        dragging.current.detail !== undefined
                      ) {
                        e.preventDefault();
                        e.stopPropagation();
                        setBlockDragOver(`${index}:${detailIndex}`);
                      }
                    }}
                    onDrop={(e) => {
                      if (
                        dragging.current?.stage === index &&
                        dragging.current.detail !== undefined
                      ) {
                        e.preventDefault();
                        e.stopPropagation();
                        moveDetail(index, dragging.current.detail, detailIndex);
                        dragging.current = null;
                        setBlockDragOver(null);
                      }
                    }}
                  >
                    <div className={styles.blockControls} data-block-actions data-open={blockMenu === detail.key || undefined}>
                    <button
                      className={styles.grip}
                      type="button"
                      draggable
                      title="Drag to move. Click for block actions."
                      aria-expanded={blockMenu === detail.key}
                      aria-haspopup="dialog"
                      onClick={(event) => { blockMenuTrigger.current = event.currentTarget; setBlockMenu(blockMenu === detail.key ? null : detail.key); }}
                      aria-label={`Move block ${detailIndex + 1} in step ${index + 1}`}
                      onKeyDown={(e) => {
                        if (
                          e.altKey &&
                          ["ArrowUp", "ArrowDown"].includes(e.key)
                        ) {
                          e.preventDefault();
                          moveDetail(
                            index,
                            detailIndex,
                            detailIndex + (e.key === "ArrowUp" ? -1 : 1),
                          );
                        }
                      }}
                      onDragStart={(e) => {
                        e.stopPropagation();
                        setBlockMenu(null);
                        dragging.current = {
                          stage: index,
                          detail: detailIndex,
                        };
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", "workflow-block");
                        e.dataTransfer.setData("application/x-screenpipe-workflow", "block");
                      }}
                      onDragEnd={() => {
                        dragging.current = null;
                        setBlockDragOver(null);
                      }}
                    >
                      <GripVertical size={15} />
                    </button>
                    {blockMenu === detail.key && <div role="dialog" aria-label={`Actions for block ${detailIndex + 1} in step ${index + 1}`} className={styles.blockMenu}>
                    <button
                      type="button"
                      title="Delete block"
                      autoFocus
                      aria-label={`Delete block ${detailIndex + 1} in step ${index + 1}`}
                      onClick={() => {
                        setBlockMenu(null);
                        stageChange(index, {
                          ...stage,
                          procedure: stage.procedure.filter(
                            (_, i) => i !== detailIndex,
                          ),
                        });
                      }}
                    >
                      <Trash2 size={14} />Delete block
                    </button>
                    </div>}
                    </div>
                    <div className={styles.kindLabel} data-kind={detail.kind}>
                      <select
                        aria-label={`Block ${detailIndex + 1} type in step ${index + 1}`}
                        title="Change block type"
                        disabled={singleCheck}
                        value={detail.kind}
                        onChange={(e) => stageChange(index, {
                          ...stage,
                          procedure: stage.procedure.map((p, i) =>
                            i === detailIndex ? { ...p, kind: e.target.value as typeof p.kind } : p,
                          ),
                        })}
                      >
                        {["action", "input", "output", "decision", "check"].map(kind =>
                          <option key={kind} value={kind}>{kind}</option>,
                        )}
                      </select>
                      <ChevronDown size={12} aria-hidden="true" />
                    </div>
                    <Text
                      rich
                      label={`Block ${detailIndex + 1} in step ${index + 1}`}
                      placeholder="Write a step detail…"
                      value={detail.text}
                      onChange={(text) =>
                        stageChange(index, {
                          ...stage,
                          procedure: stage.procedure.map((p, i) =>
                            i === detailIndex ? { ...p, text } : p,
                          ),
                        })
                      }
                    />

                  </div>
                ))}
              </div>
              {(!singleCheck || !stage.procedure.length) && <button type="button" className={styles.addDetail}
                aria-label={singleCheck ? `Add expected result to step ${index + 1}` : `Add detail to step ${index + 1}`}
                disabled={stage.procedure.length >= 100} onClick={() => addDetail(index)}>
                <Plus size={14} aria-hidden="true" />{singleCheck ? "Add expected result" : "Add detail"}
              </button>}
              {!stepsOnly && <details className={styles.execution} open={executionOpen === stage.key || undefined} onToggle={event=>{if (event.currentTarget.open) setExecutionOpen(stage.key); else if (executionOpen===stage.key) setExecutionOpen(null);}}>
                <summary>Execution details{stage.linkedWorkflowId ? " · Linked workflow" : ""}</summary>
                {Object.entries(executionFields).map(([field,label])=><div key={field} data-variable-field={field}><label>{label}</label><WorkflowRichText label={`${label} for step ${index+1}`} value={stage[field as keyof typeof executionFields] ?? ""} onChange={value=>stageChange(index,{...stage,[field]:value})}/></div>)}
                <label>Linked workflow<select value={stage.linkedWorkflowId ?? ""} onChange={e=>stageChange(index,{...stage,linkedWorkflowId:e.target.value})}><option value="">None</option>{relatedWorkflows.filter(w=>w.id && w.id!==workflow.id).map(w=><option key={w.id} value={w.id}>{w.title}{w.archived ? " (archived)" : ""}</option>)}</select></label>
              </details>}
              {stage.linkedWorkflowId && <button type="button" disabled={dirty || saving || !relatedWorkflows.some(w=>w.id===stage.linkedWorkflowId)} onClick={()=>openRelated?.(stage.linkedWorkflowId!)}>Open linked workflow: {relatedWorkflows.find(w=>w.id===stage.linkedWorkflowId)?.title ?? "Unavailable"}</button>}
              {stage.sourceIndex !== null && workflow.stages[stage.sourceIndex] && <div className={styles.source} style={stage.imageLayout?.beforeText ? { order: -1 } : undefined}>{renderSource?.({ ...workflow.stages[stage.sourceIndex], imageLayout: stage.imageLayout }, layout => stageChange(index, { ...stage, imageLayout: layout }))}</div>}
              </div>
            </article>
            </Fragment>
          ))}
        </div>
        <button
          type="button"
          className={styles.addStep}
          disabled={draft.stages.length >= 100}
          onClick={() => addStage(draft.stages.length)}
        >
          <Plus size={16} />
          Add step
        </button>
        <label className={styles.endpoint}>
          Ends with
          {stepsOnly ? <span className={styles.readOnlyText}>{workflow.outcome}</span> : <Text label="Workflow outcome" value={draft.outcome} onChange={outcome => change({ ...draft, outcome })} />}
        </label>
      </fieldset>
      {panel === "variables" && <WorkflowVariablePanel document={draft} change={change} selected={selectedVariable} select={setSelectedVariable} quote={quote} clearQuote={()=>setQuote(undefined)} source={id=>{const element = editorRoot.current?.querySelector<HTMLElement>(`[data-step-id="${id}"]`);element?.scrollIntoView({block:"center"}); element?.querySelector<HTMLElement>("textarea,[contenteditable=true]")?.focus();}} />}
      {panel === "history" && <WorkflowVersionPanel workflow={workflow} disabled={dirty || saving || saveDisabled} restore={async revision=>{
        if (busy.current) return;
        busy.current = true; setSaving(true); setError("");
        const sent = current.current;
        try {
          const saved = await save({...workflowEdit(workflow),restoreRevision:revision});
          if (!mounted.current) return;
          const next = keyedDraft(workflowEdit(saved)); baseline.current = next; setInitial(next);
          if (current.current === sent) { update(next); setHistory([]); }
          else setError("The version was restored. Your newer typing is kept in this draft; reload or review it before saving.");
          setSavedOnce(true);
        } catch(e) { if(mounted.current) setError(e instanceof Error ? e.message : "Could not restore this version."); }
        finally { busy.current = false; if(mounted.current) setSaving(false); }
      }} />}
      {panel === "details" && <aside className={styles.panel} aria-label="Workflow details"><h2>Workflow details</h2><p>{workflow.apps.join(" · ")}</p><p>{workflow.people?.join(" · ")}</p><p>{workflow.quality.reasons.join(" · ")}</p>
        <label>Review status<select value={draft.reviewStatus ?? "needs-review"} onChange={e=>change({...draft,reviewStatus:e.target.value as WorkflowMap["reviewStatus"]})}><option value="needs-review">Needs review</option><option value="needs-edits">Needs edits</option><option value="reviewed">Reviewed</option></select></label>
        <label>Review note<textarea maxLength={8000} value={draft.reviewNote ?? ""} onChange={e=>change({...draft,reviewNote:e.target.value})}/></label><small>Reviewing the instructions does not verify execution or time savings.</small>
        <button type="button" onClick={()=>change({...draft,archived:!draft.archived})}>{draft.archived ? "Unarchive workflow" : "Archive workflow"}</button><p>{draft.archived ? "Archived. Still available in the Archived filter." : "Archiving keeps this workflow and its sources."}</p>
      </aside>}
      </div>
      {renderSource && <p className={styles.note}>
        Captured sources are preserved as references. Edited instructions are
        not verified observations.
      </p>}
      <span className={styles.srOnly} role="status" aria-live="polite">
        {announcement}
      </span>
    </section>
  );
}

/** Read-only workflows share the editor's document layout without mounting draft
 * recovery, autosave, or editable controls. Permission changes do not change the
 * reading experience. */
export function WorkflowDocument({ workflow, actions, sourceLabel, renderSource }: {
  workflow: WorkflowMap;
  actions?: ReactNode;
  sourceLabel?: string;
  renderSource?: (stage: WorkflowStage, onImageLayoutChange?: (layout: NonNullable<WorkflowStage["imageLayout"]>) => void) => ReactNode;
}) {
  const [selected, select] = useState("");
  return <section className={styles.editor} aria-label="Workflow document" onClickCapture={event=>{
    const link=(event.target as Element).closest("a"); const id=variableId(link?.getAttribute("href") ?? "");
    if(id) {event.preventDefault();select(id);}
  }}>
    <header className={styles.toolbar}>
      <div><span>{sourceLabel}</span></div>
      <div>{actions}</div>
    </header>
    <div className={styles.intro}>
      <div className={styles.titleRow}>
        <h1 className={styles.title}>{workflow.title}</h1>
        <TimingDisclosure hideWhenUnknown showDuration label="Workflow timing" value={workflow.timing}
          measured={workflow.durationSource === "measured-meeting" ? { minutes: workflow.totalMinutes, samples: workflow.durationSampleCount ?? 0 } : undefined} />
      </div>
      <p className={styles.readOnlyText}>{workflow.description}</p>
    </div>
    <div className={styles.endpoint}>Starts when<span className={styles.readOnlyText}>{workflow.trigger}</span></div>
    <div className={styles.stepsHeading}><strong>Steps</strong></div>
    <div className={styles.steps}>
      {workflow.stages.map((stage, index) => <article className={styles.step} key={index} aria-label={`Step ${index + 1}`}>
        <div className={styles.stepTop}>
          <span className={styles.number}>{String(index + 1).padStart(2, "0")}</span>
          <h2 className={`${styles.title} ${styles.readOnlyText}`}>{stage.name}</h2>
          <div className={styles.stepActions}><TimingDisclosure hideWhenUnknown showDuration label={`Timing for step ${index + 1}`} value={stage.timing} /></div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
        {stage.description && <WorkflowRichText label={`Step ${index + 1} description`} value={stage.description} />}
        <div className={styles.blocks}>
          {stage.procedure?.map((detail, detailIndex) => {
            // Cloud catalogs also carry the summary as an action block. Keep its
            // reference, but do not repeat the same paragraph in the document.
            const repeatsSummary = detail.kind === "action" && detail.text.trim() === stage.description.trim();
            return <div key={detailIndex}>
              {!repeatsSummary && <div className={styles.block}>
                <WorkflowRichText label={`Block ${detailIndex + 1} in step ${index + 1}`} value={detail.text} />
                {detail.kind !== "action" && <span className={styles.readOnlyKind}>{detail.kind === "check" ? "Completion check" : detail.kind}</span>}
              </div>}
              {detail.quote && <details className={styles.reference}>
                <summary>{detail.userEdited || stage.userEdited ? "Original reference" : "Source excerpt"} · {detail.app}</summary>
                <blockquote>{detail.quote}</blockquote>
                <small>{detail.timestamp} · {detail.userEdited || stage.userEdited ? "Edited instructions are not verified by this reference" : "Text match, not execution verification"}</small>
              </details>}
            </div>;
          })}
        </div>
        {Object.entries(executionFields).map(([field,label])=>stage[field as keyof typeof executionFields] ? <div key={field}><h3>{label}</h3><WorkflowRichText label={`${label} for step ${index+1}`} value={stage[field as keyof typeof executionFields]!}/></div> : null)}
        {!!stage.apps.length && <p className={styles.stepApps}>{stage.apps.join(" · ")}</p>}
        {renderSource && <div className={styles.source} style={stage.imageLayout?.beforeText ? { order: -1 } : undefined}>{renderSource(stage)}</div>}
        </div>
      </article>)}
    </div>
    <div className={styles.endpoint}>Ends with<span className={styles.readOnlyText}>{workflow.outcome}</span></div>
    {!!workflow.variables?.length && <WorkflowVariablePanel document={workflowEdit(workflow)} selected={selected} select={select} clearQuote={()=>{}} source={()=>{}}/>}
  </section>;
}
