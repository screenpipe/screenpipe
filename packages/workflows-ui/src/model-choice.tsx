// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";
import { useEffect, useState } from "react";
import { ConfidentialVerificationBadge, type ConfidentialVerificationSource } from "./confidential-verification";

export type WorkflowModelMode = "intelligent" | "private";
export type WorkflowModelPreference = {
  verification?: ConfidentialVerificationSource;
  load(): Promise<WorkflowModelMode>;
  save(mode: WorkflowModelMode): Promise<void>;
};
export const WORKFLOW_MODELS = {
  intelligent: { label: "Intelligent", model: "auto", description: "Automatically chooses a model. Uses your AI allowance." },
  private: { label: "Private (Beta)", model: "glm-5.3-flash-reap50-iq3m", description: "Experimental encrypted AI processing. Separate usage, subject to capacity limits." },
} as const;
export function parseWorkflowModel(text: string | null): WorkflowModelMode {
  if (text === null) return "intelligent";
  const mode = JSON.parse(text)?.mode;
  if (mode !== "intelligent" && mode !== "private") throw new Error("Could not read your saved AI choice.");
  return mode;
}
export function WorkflowModelControl({ preference }: { preference: WorkflowModelPreference }) {
  const [mode, setMode] = useState<WorkflowModelMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () => {
      preference.load().then(value => { if (active) { setMode(value); setError(""); } })
        .catch(() => { if (active) { setMode(null); setError("Could not read your AI choice. Select it again."); } });
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("workflows:model-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("workflows:model-changed", refresh);
    };
  }, [preference]);
  return <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
    <label title={mode ? `${WORKFLOW_MODELS[mode].description} Applies to new runs.` : "Choose how Workflows processes your data"}>
      <span style={{ marginRight: 6 }}>AI</span>
      <select aria-label="Workflows AI" value={mode ?? ""} disabled={busy} onChange={async event => {
        const next = event.target.value as WorkflowModelMode;
        setBusy(true); setError("");
        try { await preference.save(next); setMode(next); }
        catch { setError("Could not save your AI choice. Try again."); }
        finally { setBusy(false); }
      }} style={{ background: "transparent", color: "inherit", border: "1px solid currentColor", borderRadius: 6, padding: "4px 6px", font: "inherit" }}>
        {!mode && <option value="" disabled>Choose…</option>}
        {Object.entries(WORKFLOW_MODELS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
      </select>
    </label>
    {mode === "private" && <ConfidentialVerificationBadge source={preference.verification} />}
    {error && <span role="alert">{error}</span>}
  </div>;
}
