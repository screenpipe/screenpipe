// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useState } from "react";
import type { WorkflowVariable } from "./model";
import type { WorkflowEdit } from "./workflow-edits";
import {
  addVariableExample,
  stageFields,
  updateVariable,
} from "./workflow-variables";
import styles from "./workflow-editor.module.css";
export type VariableQuote = WorkflowVariable["examples"][number];
export function WorkflowVariablePanel<T extends WorkflowEdit>({
  document,
  change,
  selected,
  select,
  quote,
  clearQuote,
  source,
}: {
  document: T;
  change?: (value: T) => void;
  selected: string;
  select: (id: string) => void;
  quote?: VariableQuote;
  clearQuote: () => void;
  source: (id: string) => void;
}) {
  const [form, setForm] = useState<{
    kind: "input" | "output";
    existing?: WorkflowVariable;
    edit?: boolean;
  }>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [stepId, setStepId] = useState("");
  const [field, setField] = useState("description");
  const [error, setError] = useState("");
  useEffect(() => {
    if (quote) {
      setValue(quote.value);
      setStepId(quote.stepId);
      setField(quote.field);
    }
  }, [quote]);
  const items = document.variables ?? [];
  const step = document.stages.find((s, i) => (s.id ?? `step-${i}`) === stepId);
  const open = (
    kind: "input" | "output",
    existing?: WorkflowVariable,
    edit = false,
  ) => {
    setForm({ kind, existing, edit });
    setName(existing?.name ?? "");
    setDescription(existing?.description ?? "");
    setValue(quote?.value ?? "");
    setStepId(quote?.stepId ?? document.stages[0]?.id ?? "step-0");
    setField(quote?.field ?? "description");
    setError("");
  };
  return (
    <aside className={styles.panel} aria-label="Inputs and outputs">
      <h2>Inputs and outputs</h2>
      <p>Reusable fields with example values.</p>
      {quote && <p role="status">Selected: {quote.value.slice(0, 100)}</p>}
      {(["input", "output"] as const).map((kind) => (
        <section
          key={kind}
          aria-label={kind === "input" ? "Inputs" : "Outputs"}
        >
          <header>
            <h3>{kind === "input" ? "Inputs" : "Outputs"}</h3>
            {change && (
              <button
                type="button"
                disabled={items.length >= 40}
                onClick={() => open(kind)}
              >
                Add {kind}
              </button>
            )}
          </header>
          {!items.some((v) => v.kind === kind) && <p>No {kind}s yet.</p>}
          {items
            .filter((v) => v.kind === kind)
            .map((item) => (
              <div key={item.id} className={styles.variable}>
                <button
                  type="button"
                  aria-expanded={selected === item.id}
                  onClick={() => select(selected === item.id ? "" : item.id)}
                >
                  {item.name}
                </button>
                {selected !== item.id ? (
                  <p>
                    {item.examples[0]
                      ? `e.g. ${item.examples[0].value}`
                      : "No example value saved yet"}
                  </p>
                ) : (
                  <>
                    <p>{item.description}</p>
                    {item.examples.map((example, i) => (
                      <div key={i}>
                        <blockquote>{example.value}</blockquote>
                        {document.stages.some(
                          (s, index) =>
                            (s.id ?? `step-${index}`) === example.stepId,
                        ) ? (
                          <button
                            type="button"
                            onClick={() => source(example.stepId)}
                          >
                            Source step ·{" "}
                            {example.field.startsWith("block/")
                              ? "Step detail"
                              : example.field === "description"
                                ? "Instructions"
                                : (stageFields(
                                    document.stages.find(
                                      (s, index) =>
                                        (s.id ?? `step-${index}`) ===
                                        example.stepId,
                                    )!,
                                  ).find((f) => f.id === example.field)
                                    ?.label ?? "Original field")}
                          </button>
                        ) : (
                          <p>Original source step was removed.</p>
                        )}
                      </div>
                    ))}
                    {!item.examples.length && (
                      <p>No example value saved yet.</p>
                    )}
                    <small>
                      Examples from instructions, not verified execution.
                    </small>
                    {change && (
                      <div>
                        <button
                          type="button"
                          onClick={() => open(kind, item, true)}
                        >
                          Edit definition
                        </button>
                        <button
                          type="button"
                          disabled={item.examples.length >= 20}
                          onClick={() => open(kind, item)}
                        >
                          Add example
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            change(updateVariable(document, item.id));
                            select("");
                          }}
                        >
                          Remove field
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
        </section>
      ))}
      {form && change && (
        <form
          aria-label={`Define ${form.kind}`}
          onSubmit={(event) => {
            event.preventDefault();
            setError("");
            try {
              const item = {
                ...(form.existing ?? {
                  id: crypto.randomUUID(),
                  kind: form.kind,
                  examples: [],
                }),
                name: name.trim(),
                description: description.trim(),
              };
              change(
                form.edit
                  ? updateVariable(document, item.id, item)
                  : addVariableExample(document, item, {
                      stepId,
                      field,
                      value: value.trim(),
                    }),
              );
              select(item.id);
              setForm(undefined);
              clearQuote();
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Could not save variable.",
              );
            }
          }}
        >
          <h3>
            {form.edit
              ? "Edit definition"
              : form.existing
                ? "Add example"
                : `Define ${form.kind}`}
          </h3>
          {(!form.existing || form.edit) && (
            <>
              <label>
                Name
                <input
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                Description
                <textarea
                  maxLength={1000}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
            </>
          )}
          {!form.edit && (
            <>
              <label>
                Source step
                <select
                  value={stepId}
                  onChange={(e) => {
                    setStepId(e.target.value);
                    setField("description");
                  }}
                >
                  {document.stages.map((s, i) => (
                    <option key={s.id ?? i} value={s.id ?? `step-${i}`}>
                      {i + 1}. {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Source field
                <select
                  value={field}
                  onChange={(e) => setField(e.target.value)}
                >
                  {step &&
                    stageFields(step).map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Example value
                <textarea
                  required
                  maxLength={1000}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </label>
              <p>
                Replace this exact value with a named reference. Keep the
                original here as an example.
              </p>
            </>
          )}
          {error && <p role="alert">{error}</p>}
          <button type="submit">
            {form.edit ? "Save definition" : "Use named reference"}
          </button>
          <button type="button" onClick={() => setForm(undefined)}>
            Cancel
          </button>
        </form>
      )}
    </aside>
  );
}
