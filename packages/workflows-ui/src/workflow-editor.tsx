// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  MoreHorizontal,
  Plus,
  Trash2,
  Undo2,
} from "lucide-react";
import type { WorkflowMap, WorkflowStage } from "./model";
import {
  moveBlock,
  validWorkflowEdit,
  workflowEdit,
  type WorkflowEdit,
  type StageEdit,
} from "./workflow-edits";
import { WorkflowRichText } from "./rich-text";
import styles from "./workflow-editor.module.css";

function Text({
  label,
  value,
  onChange,
  title = false,
  placeholder = label,
  rich = false,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  title?: boolean;
  placeholder?: string;
  rich?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    const resize = () => {
      field.style.height = "0px";
      field.style.height = `${field.scrollHeight}px`;
    };
    resize();
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth !== width) {
        width = field.clientWidth;
        resize();
      }
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [value]);
  if (rich) return <WorkflowRichText label={label} value={value} onChange={onChange} placeholder={placeholder} maxLength={8000} />;
  return (
    <textarea
      ref={ref}
      rows={1}
      aria-label={label}
      placeholder={placeholder}
      className={title ? styles.title : undefined}
      value={value}
      maxLength={8000}
      onChange={(e) => onChange(e.target.value)}
    />
  );
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

export function WorkflowEditor({ workflow, save, actions, renderSource }: {
  workflow: WorkflowMap;
  save: (draft: WorkflowEdit) => Promise<WorkflowMap>;
  actions?: ReactNode;
  renderSource?: (stage: WorkflowStage) => ReactNode;
}) {
  const key = `screenpipe:workflow-edit:${workflow.id ?? workflow.title}`;
  const [initial, setInitial] = useState(() => keyedDraft(workflowEdit(workflow)));
  const [draft, setDraft] = useState<EditorDraft>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || "null");
      if (saved?.id === initial.id && validWorkflowEdit(saved, true)) return keyedDraft(saved);
    } catch { /* Optional tab-local recovery. */ }
    return initial;
  });
  const [history, setHistory] = useState<EditorDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [blockDragOver, setBlockDragOver] = useState<string | null>(null);
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
    const dismiss = (event: PointerEvent) => {
      editorRoot.current?.querySelectorAll<HTMLDetailsElement>("details[data-step-actions][open]").forEach(menu => {
        if (!(event.target instanceof Node) || !menu.contains(event.target)) menu.open = false;
      });
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  const dragging = useRef<{ stage: number; detail?: number } | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const current = useRef(draft);
  const baseline = useRef(initial);
  const dirty = JSON.stringify(payload(draft)) !== JSON.stringify(payload(initial));
  const valid = validWorkflowEdit(draft);
  function remember(next: EditorDraft, base = baseline.current) {
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
  function update(next: EditorDraft) {
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
    if (!validWorkflowEdit(sent) || busy.current || JSON.stringify(payload(sent)) === JSON.stringify(payload(baseline.current))) return;
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
    if (!dirty && !saving && draft.expected_revision !== (workflow.revision ?? 0)) useLatest();
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
      className={styles.editor}
      aria-label="Workflow document"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          void submit();
        }
        // Keep host navigation shortcuts out of editable blocks.
        e.stopPropagation();
      }}
    >
      <header className={styles.toolbar}>
        <div><span role="status" aria-label="Save status">{error ? "Not saved" : saving ? "Saving…" : dirty ? valid ? "Saving…" : "Finish the empty block to save" : savedOnce ? "Saved" : ""}</span></div>
        <div>
          {actions}
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
      <fieldset>
        <div className={styles.intro}>
          <Text
            title
            label="Workflow title"
            value={draft.title}
            onChange={(title) => change({ ...draft, title })}
          />
          <Text
            label="Workflow description"
            value={draft.description}
            onChange={(description) => change({ ...draft, description })}
          />
        </div>
        <label className={styles.endpoint}>
          Starts when
          <Text
            label="Workflow trigger"
            value={draft.trigger}
            onChange={(trigger) => change({ ...draft, trigger })}
          />
        </label>
        <div className={styles.stepsHeading}><strong>Steps</strong></div>
        <div className={styles.steps}>
          {draft.stages.map((stage, index) => (
            <article
              className={`${styles.step} ${dragOver === index ? styles.drop : ""}`}
              key={stage.key}
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
                <button
                  type="button"
                  className={styles.grip}
                  draggable
                  title="Drag step. Alt + Up/Down to reorder."
                  aria-label={`Move step ${index + 1}`}
                  onKeyDown={(e) => {
                    if (e.altKey && ["ArrowUp", "ArrowDown"].includes(e.key)) {
                      e.preventDefault();
                      moveStage(index, index + (e.key === "ArrowUp" ? -1 : 1));
                    }
                  }}
                  onDragStart={(e) => {
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
                <span className={styles.number}>
                  {String(index + 1).padStart(2, "0")}
                </span>
              <Text
                title
                label={`Step ${index + 1} title`}
                value={stage.name}
                onChange={(name) => stageChange(index, { ...stage, name })}
              />
                <details data-step-actions className={styles.controls} onKeyDown={event => {
                  if (event.key === "Escape") {
                    event.preventDefault(); event.stopPropagation();
                    event.currentTarget.open = false;
                    event.currentTarget.querySelector<HTMLElement>("summary")?.focus();
                  }
                }}><summary aria-label={`Step ${index + 1} actions`} title="Step actions"><MoreHorizontal size={16} /></summary><div className={styles.stepMenu}>
                  <button
                    type="button"
                    aria-label={`Move step ${index + 1} up`}
                    title="Move up"
                    disabled={index === 0}
                    onClick={() => moveStage(index, index - 1)}
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move step ${index + 1} down`}
                    title="Move down"
                    disabled={index === draft.stages.length - 1}
                    onClick={() => moveStage(index, index + 1)}
                  >
                    <ArrowDown size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete step ${index + 1}`}
                    title="Delete step"
                    disabled={draft.stages.length === 1}
                    onClick={() =>
                      change({
                        ...draft,
                        stages: draft.stages.filter((_, i) => i !== index),
                      })
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div></details>
              </div>
              <Text
                rich
                label={`Step ${index + 1} description`}
                value={stage.description}
                onChange={(description) =>
                  stageChange(index, { ...stage, description })
                }
              />
              <div className={styles.blocks}>
                {stage.procedure.map((detail, detailIndex) => (
                  <div
                    className={`${styles.block} ${blockDragOver === `${index}:${detailIndex}` ? styles.blockDrop : ""}`}
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
                      <label>Block type
                    <select
                      autoFocus
                      aria-label={`Block ${detailIndex + 1} type in step ${index + 1}`}
                      value={detail.kind}
                      onChange={(e) =>
                        stageChange(index, {
                          ...stage,
                          procedure: stage.procedure.map((p, i) =>
                            i === detailIndex
                              ? { ...p, kind: e.target.value as typeof p.kind }
                              : p,
                          ),
                        })
                      }
                    >
                      {["action", "input", "output", "decision", "check"].map(
                        (kind) => (
                          <option key={kind}>{kind}</option>
                        ),
                      )}
                    </select>
                      </label>
                    <button
                      type="button"
                      title="Delete block"
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
                    {detail.kind !== "action" && <span className={styles.kindLabel}>{detail.kind}</span>}
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
              {stage.sourceIndex !== null && workflow.stages[stage.sourceIndex] && <div className={styles.source}>{renderSource?.(workflow.stages[stage.sourceIndex])}</div>}
              <button
                type="button"
                className={styles.add}
                title="Add block"
                disabled={stage.procedure.length >= 100}
                onClick={() => {
                  stageChange(index, {
                    ...stage,
                    procedure: [
                      ...stage.procedure,
                      { key: crypto.randomUUID(), sourceIndex: null, kind: "action", text: "" },
                    ],
                  });
                  focusField(
                    `Block ${stage.procedure.length + 1} in step ${index + 1}`,
                  );
                }}
              >
                <Plus size={14} />
                Add block
              </button>
            </article>
          ))}
        </div>
        <button
          type="button"
          className={styles.addStep}
          disabled={draft.stages.length >= 100}
          onClick={() => {
            change({
              ...draft,
              stages: [
                ...draft.stages,
                { key: crypto.randomUUID(), sourceIndex: null, name: "", description: "", procedure: [] },
              ],
            });
            focusField(`Step ${draft.stages.length + 1} title`);
          }}
        >
          <Plus size={16} />
          Add step
        </button>
        <label className={styles.endpoint}>
          Ends with
          <Text
            label="Workflow outcome"
            value={draft.outcome}
            onChange={(outcome) => change({ ...draft, outcome })}
          />
        </label>
      </fieldset>
      <p className={styles.note}>
        Captured sources are preserved as references. Edited instructions are
        not verified observations.
      </p>
      <span className={styles.srOnly} role="status" aria-live="polite">
        {announcement}
      </span>
    </section>
  );
}
