// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useState } from "react";
import type { WorkflowMap } from "./model";
import { workflowEdit } from "./workflow-edits";
import { stageFields } from "./workflow-variables";
import styles from "./workflow-editor.module.css";
function fields(workflow: WorkflowMap) {
  const draft = workflowEdit(workflow);
  return Object.fromEntries([
    ["Title", draft.title],
    ["Description", draft.description],
    ["Starts when", draft.trigger],
    ["Ends with", draft.outcome],
    ...draft.stages.flatMap((s, i) => [
      [`Step ${i + 1}`, s.name],
      ...stageFields(s).map((f) => [`Step ${i + 1} · ${f.label}`, f.value]),
      [`Step ${i + 1} · Linked workflow`, s.linkedWorkflowId ?? ""],
    ]),
    [
      "Variables",
      (draft.variables ?? [])
        .map(
          (v) =>
            `${v.name} (${v.kind})\n${v.description}\n${v.examples.map((e) => `Example: ${e.value}`).join("\n")}`,
        )
        .join("\n\n"),
    ],
    ["Review", draft.reviewStatus ?? "needs-review"],
    ["Review note", draft.reviewNote ?? ""],
    ["Archived", String(!!draft.archived)],
  ]);
}
export function WorkflowVersionPanel({
  workflow,
  restore,
  disabled,
}: {
  workflow: WorkflowMap;
  restore: (revision: number) => void;
  disabled: boolean;
}) {
  const versions = workflow.versions ?? [];
  const [revision, setRevision] = useState(versions.at(-1)?.revision);
  const selected = versions.find((v) => v.revision === revision);
  useEffect(() => {
    if (!versions.some((v) => v.revision === revision))
      setRevision(versions.at(-1)?.revision);
  }, [versions, revision]);
  const before = selected ? fields(selected.snapshot) : {};
  const after = fields(workflow);
  const keys = [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].filter((key) => before[key] !== after[key]);
  return (
    <aside className={styles.panel} aria-label="Version history">
      <h2>Version history</h2>
      <p>
        Recent saved edits. Restoring creates a new version and keeps the
        selected version’s sources.
      </p>
      {!versions.length ? (
        <p>No earlier saved edits yet.</p>
      ) : (
        <>
          <label>
            Saved version
            <select
              value={revision ?? ""}
              onChange={(e) => setRevision(Number(e.target.value))}
            >
              {[...versions].reverse().map((v) => (
                <option key={v.revision} value={v.revision}>
                  Revision {v.revision} ·{" "}
                  {v.at ? new Date(v.at).toLocaleString() : "Original"}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <>
              <h3>Compared with current</h3>
              {keys.length ? (
                keys.map((key) => (
                  <details key={key} open>
                    <summary>{key}</summary>
                    <small>Selected version</small>
                    <pre>{(before[key] || "Empty").replace(/\[([^\]]+)\]\(#workflow-io-[a-zA-Z0-9_-]+\)/g,"$1")}</pre>
                    <small>Current</small>
                    <pre>{(after[key] || "Empty").replace(/\[([^\]]+)\]\(#workflow-io-[a-zA-Z0-9_-]+\)/g,"$1")}</pre>
                  </details>
                ))
              ) : (
                <p>The document fields match.</p>
              )}
              <button
                type="button"
                disabled={disabled}
                onClick={() => restore(selected.revision)}
              >
                Restore revision {selected.revision}
              </button>
              {disabled && (
                <p>Finish saving the current draft before restoring.</p>
              )}
            </>
          )}
        </>
      )}
    </aside>
  );
}
