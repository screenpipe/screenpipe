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
  cloudProcedureWorkflow, cloudProcedureEdit,
  type CloudDraftStore,
  type CloudWorkflowIdentity,
} from "./cloud-workflow";
import { WorkflowDetail } from "./workflows-app";
import { workflowEdit, type WorkflowEdit } from "./workflow-edits";
import type { WorkflowMap } from "./model";
import type { WorkflowsPlatform } from "./platform";
import type { WorkflowsAssistantPlatform } from "./assistant";
const readOnlyPlatform: WorkflowsPlatform = {
  ensureRuntime: async () => { throw new Error("Cloud workflows have no local runtime"); },
  analyzeCapturedWork: async () => { throw new Error("Cloud workflows cannot start device analysis"); },
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function CloudWorkflowEditor({
  identity,
  workflow,
  appearance,
  active = true,
  request,
  drafts,
  back,
  onSaved,
  onDenied,
}: {
  identity: CloudWorkflowIdentity;
  workflow: WorkflowMap;
  appearance?: Pick<WorkflowsAssistantPlatform, "load" | "save">;
  active?: boolean;
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
  const base = useRef<CloudProcedure | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const converted = useRef<{ key: string; value: CloudProcedure } | null>(null);
  function convert(edit: WorkflowEdit) {
    const key = JSON.stringify([base.current, edit]);
    if (converted.current?.key !== key) converted.current = { key, value: cloudProcedureEdit(base.current!, edit) };
    return converted.current.value;
  }
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
        base.current = draft && current.can_edit && !current.review.frozen ? draft : current;
        setEditorEpoch(n => n + 1);
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
  async function save(edit: WorkflowEdit): Promise<WorkflowMap> {
    if (!base.current || !editable || conflict || pending.current) throw new Error("This workflow cannot be saved right now.");
    pending.current = true;
    setSaving(true);
    setError("");
    const snapshot = convert(edit);
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
      base.current = next;
      setValue(next);
      setSaved(next);
      if (draftKey) await drafts?.save(draftKey, null);
      callbacks.current.onSaved();
      return cloudProcedureWorkflow(workflow, next);
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
      throw cause;
    } finally {
      pending.current = false;
      if (!alive.current?.signal.aborted) setSaving(false);
    }
  }
  async function discard() {
    if (draftKey) await drafts?.save(draftKey, null);
    setRevision((n) => n + 1);
  }
  if (!value || !saved) return <section>{error && <p role="alert">{error}</p>}{loading ? <p role="status">Loading workflow…</p> : <button onClick={() => setRevision(n => n + 1)}>Retry</button>}</section>;
  const display = cloudProcedureWorkflow(workflow, saved);
  return <>
    {error && <p role="alert">{error}</p>}
    {conflict && <p role="alert">This workflow changed since your draft was saved. Your draft is kept. <button onClick={() => void discard().catch(cause => setError(String(cause)))}>Discard draft and reload</button></p>}
    {!editable && <p>{saved.review.frozen ? "Approved workflow. Ask an admin to reopen it before editing." : "View only. Your admin controls workflow editing."}</p>}
    <WorkflowDetail key={`${key}-${editorEpoch}`} workflow={display} active={active} navigate={() => back()} platform={readOnlyPlatform} workProfile={null}
      canSaveAnswers={false} observationsAvailable={false} onAnswersSaved={() => {}}
      sourceLabel={`Your cloud workflow · Version ${saved.revision}`}
      saveEdits={editable ? save : undefined}
      editorOptions={{ stepsOnly: true, singleCheck: true, sessionRecovery: false, saveDisabled: conflict || loading,
        initialDraft: workflowEdit(cloudProcedureWorkflow(workflow, value)),
        onDraftChange: edit => { if (base.current) setValue(convert(edit)); },
      }} />
    {editable && <CloudWorkflowChat identity={identity} title={workflow.title} appearance={appearance} request={request} canApply={!dirty && !saving && !loading}
      onApplied={() => { setRevision(n => n + 1); callbacks.current.onSaved(); }}
      onDenied={() => { setValue(null); callbacks.current.onDenied(); }} />}
  </>;
}
