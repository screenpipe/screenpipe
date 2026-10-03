// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useRef, useState } from "react";
import { CloudWorkflowChat } from "./cloud-workflow-chat";
import {
  cloudWorkflowRequest,
  isCloudProcedure,
  CloudWorkflowAccessError,
  type CloudProcedure,
  type CloudProcedureStep,
  type CloudDraftStore,
  type CloudWorkflowIdentity,
} from "./cloud-workflow";
import styles from "./cloud-workflow.module.css";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function CloudWorkflowEditor({
  identity,
  title,
  summary,
  request,
  drafts,
  back,
  onSaved,
  onDenied,
}: {
  identity: CloudWorkflowIdentity;
  title: string;
  summary: string;
  request: typeof fetch;
  drafts?: CloudDraftStore;
  back: () => void;
  onSaved: () => void;
  onDenied: () => void;
}) {
  const [value, setValue] = useState<CloudProcedure | null>(null);
  const [saved, setSaved] = useState<CloudProcedure | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const alive = useRef<AbortController | undefined>(undefined);
  const pending = useRef(false);
  const callbacks = useRef({ onSaved, onDenied });
  callbacks.current = { onSaved, onDenied };
  const key = JSON.stringify(identity);
  const loadedKey = useRef("");
  const dirty = Boolean(
    value && saved && !same(value.document, saved.document),
  );
  const editable = Boolean(saved?.can_edit && !saved.review.frozen);
  useEffect(() => {
    const refresh = () => {
      if (!dirty && !saving && document.visibilityState === "visible")
        setRevision((n) => n + 1);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [dirty, saving]);

  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    setLoading(true);
    setError("");
    if (loadedKey.current !== key) {
      setValue(null);
      setSaved(null);
    }
    loadedKey.current = key;
    setDraftKey("");
    void (async () => {
      try {
        const current: CloudProcedure = await cloudWorkflowRequest(
          request,
          "procedure",
          identity,
          "GET",
          undefined,
          controller.signal,
        );
        if (!isCloudProcedure(current))
          throw new Error(
            "The workflow response could not be read. Refresh to try again.",
          );
        const storageKey = current.actor_scope
          ? `${current.actor_scope}-${identity.workflow_id}`
          : "";
        const draft = storageKey ? await drafts?.load(storageKey) : null;
        controller.signal.throwIfAborted();
        setSaved(current);
        setDraftKey(storageKey);
        setConflict(
          Boolean(
            draft &&
            (draft.revision !== current.revision ||
              draft.source_version !== current.source_version),
          ),
        );
        setValue(
          draft && current.can_edit && !current.review.frozen
            ? {
                ...draft,
                can_edit: current.can_edit,
                review: current.review,
                actor_scope: current.actor_scope,
              }
            : current,
        );
      } catch (cause) {
        if (!controller.signal.aborted) {
          setValue(null);
          setSaved(null);
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load this workflow.",
          );
          if (cause instanceof CloudWorkflowAccessError)
            callbacks.current.onDenied();
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [key, request, drafts, revision]);
  useEffect(() => {
    if (!value || !dirty || !draftKey || !drafts || loading) return;
    void drafts
      .save(draftKey, value)
      .catch(() =>
        setError(
          "Your draft could not be saved on this device. Keep this workflow open and retry.",
        ),
      );
  }, [value, dirty, draftKey, drafts, loading]);
  const change = (index: number, update: Partial<CloudProcedureStep>) =>
    setValue(
      (current) =>
        current && {
          ...current,
          document: {
            ...current.document,
            steps: current.document.steps.map((step, i) =>
              i === index ? { ...step, ...update } : step,
            ),
          },
        },
    );
  const move = (from: number, to: number) =>
    setValue((current) => {
      if (!current || to < 0 || to >= current.document.steps.length)
        return current;
      const steps = [...current.document.steps];
      steps.splice(to, 0, steps.splice(from, 1)[0]);
      return { ...current, document: { ...current.document, steps } };
    });
  function add() {
    setValue(
      (current) =>
        current && {
          ...current,
          document: {
            ...current.document,
            steps: [
              ...current.document.steps,
              {
                id: crypto.randomUUID(),
                action: "New step",
                kind: "action",
                app: "",
                detail: "",
                expected_result: "",
                caveat: "",
                required_access: "",
                escalation: "",
                response_template: "",
              },
            ],
          },
        },
    );
  }
  function remove(id: string) {
    setValue(
      (current) =>
        current && {
          ...current,
          document: {
            ...current.document,
            steps: current.document.steps
              .filter((step) => step.id !== id)
              .map((step) => ({
                ...step,
                ...(step.next_step_id === id
                  ? { next_step_id: undefined }
                  : {}),
                ...(step.decision
                  ? {
                      decision: {
                        ...step.decision,
                        ...(step.decision.yes_step_id === id
                          ? { yes_step_id: undefined }
                          : {}),
                        ...(step.decision.no_step_id === id
                          ? { no_step_id: undefined }
                          : {}),
                      },
                    }
                  : {}),
              })),
          },
        },
    );
  }
  async function save() {
    if (!value || !dirty || !editable || conflict || pending.current) return;
    pending.current = true;
    setSaving(true);
    setError("");
    const snapshot = value;
    try {
      const result = await cloudWorkflowRequest(
        request,
        "procedure",
        identity,
        "PUT",
        {
          document: snapshot.document,
          expected_revision: snapshot.revision,
          source_version: snapshot.source_version,
        },
        alive.current!.signal,
      );
      alive.current!.signal.throwIfAborted();
      const next = {
        ...snapshot,
        revision: result.revision,
        review: result.review,
      };
      setValue(next);
      setSaved(next);
      if (draftKey) await drafts?.save(draftKey, null);
      callbacks.current.onSaved();
    } catch (cause) {
      if (!alive.current?.signal.aborted) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not save. Your draft is still here.",
        );
        if (cause instanceof CloudWorkflowAccessError) {
          setValue(null);
          setSaved(null);
          callbacks.current.onDenied();
        }
      }
    } finally {
      pending.current = false;
      if (!alive.current?.signal.aborted) setSaving(false);
    }
  }
  async function discard() {
    if (draftKey) await drafts?.save(draftKey, null);
    setRevision((n) => n + 1);
  }
  return (
    <section className={styles.editor}>
      <button onClick={back}>← All workflows</button>
      <header>
        <h1>{title}</h1>
        <p>{summary}</p>
      </header>
      {loading && !value ? (
        <p role="status">Loading workflow…</p>
      ) : (
        <>
          {error && <p role="alert">{error}</p>}
          {!value ? (
            <button onClick={() => setRevision((n) => n + 1)}>Retry</button>
          ) : (
            <div className={styles.layout}>
              <div>
                <div className={styles.actions}>
                  <span role="status">
                    {saving
                      ? "Saving…"
                      : dirty
                        ? "Unsaved changes"
                        : `Saved · Version ${value.revision}`}
                  </span>
                  {editable && (
                    <button
                      disabled={!dirty || saving || conflict || loading}
                      onClick={() => void save()}
                    >
                      Save changes
                    </button>
                  )}
                  {dirty && (
                    <button
                      disabled={saving}
                      onClick={() =>
                        void discard().catch((cause) => setError(String(cause)))
                      }
                    >
                      Discard draft and reload
                    </button>
                  )}
                </div>
                {conflict && (
                  <p role="alert">
                    This workflow changed since your draft was saved. Your draft
                    is shown below. Copy the changes you need, then discard the
                    draft to load the latest version.
                  </p>
                )}
                {!editable && (
                  <p>
                    {saved?.review.frozen
                      ? "Approved workflow. Ask an admin to reopen it before editing."
                      : "View only. Your admin controls workflow editing."}
                  </p>
                )}
                <ol className={styles.steps}>
                  {value.document.steps.map((step, index) => (
                    <li key={step.id}>
                      <fieldset disabled={!editable || saving || loading}>
                        <legend>Step {index + 1}</legend>
                        <label>
                          Action
                          <input
                            aria-label={`Step ${index + 1} action`}
                            value={step.action}
                            maxLength={300}
                            onChange={(e) =>
                              change(index, { action: e.target.value })
                            }
                          />
                        </label>
                        <label>
                          Instructions
                          <textarea
                            aria-label={`Step ${index + 1} instructions`}
                            value={step.detail}
                            maxLength={4000}
                            rows={3}
                            onChange={(e) =>
                              change(index, { detail: e.target.value })
                            }
                          />
                        </label>
                        <label>
                          Expected result
                          <textarea
                            value={step.expected_result}
                            maxLength={4000}
                            rows={2}
                            onChange={(e) =>
                              change(index, { expected_result: e.target.value })
                            }
                          />
                        </label>
                        <details>
                          <summary>Step details</summary>
                          <label>
                            Step type
                            <select
                              value={step.kind}
                              onChange={(e) =>
                                change(index, {
                                  kind: e.target
                                    .value as CloudProcedureStep["kind"],
                                  decision:
                                    e.target.value === "decision"
                                      ? step.decision || {
                                          condition: "",
                                          if_yes: "",
                                          if_no: "",
                                        }
                                      : undefined,
                                })
                              }
                            >
                              <option value="action">Action</option>
                              <option value="decision">Decision</option>
                              <option value="check">Check</option>
                            </select>
                          </label>
                          <label>
                            App
                            <input
                              value={step.app}
                              maxLength={200}
                              onChange={(e) =>
                                change(index, { app: e.target.value })
                              }
                            />
                          </label>
                          {(
                            [
                              "caveat",
                              "required_access",
                              "escalation",
                              "response_template",
                            ] as const
                          ).map((field) => (
                            <label key={field}>
                              {field.replaceAll("_", " ")}
                              <textarea
                                value={step[field]}
                                rows={2}
                                maxLength={4000}
                                onChange={(e) =>
                                  change(index, { [field]: e.target.value })
                                }
                              />
                            </label>
                          ))}
                          {step.decision &&
                            (["condition", "if_yes", "if_no"] as const).map(
                              (field) => (
                                <label key={field}>
                                  {field.replaceAll("_", " ")}
                                  <textarea
                                    value={step.decision![field]}
                                    onChange={(e) =>
                                      change(index, {
                                        decision: {
                                          ...step.decision!,
                                          [field]: e.target.value,
                                        },
                                      })
                                    }
                                  />
                                </label>
                              ),
                            )}
                        </details>
                        {editable && (
                          <div className={styles.actions}>
                            <button
                              disabled={!index}
                              onClick={() => move(index, index - 1)}
                              aria-label={`Move step ${index + 1} up`}
                            >
                              Move up
                            </button>
                            <button
                              disabled={value.document.steps.length === 1}
                              onClick={() => remove(step.id)}
                              aria-label={`Remove step ${index + 1}`}
                            >
                              Remove
                            </button>
                            <button
                              disabled={
                                index === value.document.steps.length - 1
                              }
                              onClick={() => move(index, index + 1)}
                              aria-label={`Move step ${index + 1} down`}
                            >
                              Move down
                            </button>
                          </div>
                        )}
                      </fieldset>
                    </li>
                  ))}
                </ol>
                {editable && (
                  <button
                    disabled={saving || value.document.steps.length >= 100}
                    onClick={add}
                  >
                    Add step
                  </button>
                )}
              </div>
              {editable && (
                <CloudWorkflowChat
                  identity={identity}
                  request={request}
                  canApply={!dirty && !saving && !loading}
                  onApplied={() => {
                    setRevision((n) => n + 1);
                    callbacks.current.onSaved();
                  }}
                  onDenied={() => {
                    setValue(null);
                    callbacks.current.onDenied();
                  }}
                />
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
