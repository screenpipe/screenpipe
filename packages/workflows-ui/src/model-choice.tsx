// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";
import { useEffect, useId, useRef, useState } from "react";
import { ConfidentialVerificationDetails, useConfidentialVerification, type ConfidentialVerificationSource } from "./confidential-verification";

import { Check, ChevronDown, Shield, Sparkles } from "lucide-react";
import styles from "./model-choice.module.css";
import { useGT, msg, useMessages } from "gt-react";


export type WorkflowModelMode = "intelligent" | "private";
export type WorkflowModelPreference = {
  verification?: ConfidentialVerificationSource;
  load(): Promise<WorkflowModelMode>;
  save(mode: WorkflowModelMode): Promise<void>;
};
export const WORKFLOW_MODELS = {
  intelligent: { label: msg("Intelligent"), model: "auto", description: msg("Automatically chooses a model. Uses your AI allowance.") },
  private: { label: msg("Private (Beta)"), model: "glm-5.3-flash-reap50-iq3m", description: msg("Experimental encrypted AI processing. Separate usage, subject to capacity limits.") },
} as const;
export function parseWorkflowModel(text: string | null): WorkflowModelMode {
  if (text === null) return "intelligent";
  const mode = JSON.parse(text)?.mode;
  if (mode !== "intelligent" && mode !== "private") throw new Error("Could not read your saved AI choice.");
  return mode;
}
export function WorkflowModelControl({ preference }: { preference: WorkflowModelPreference }) {
  const ui = useGT();
  const uiMessages = useMessages();
  const [mode, setMode] = useState<WorkflowModelMode | null>(null);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  // Keep listening while the dropdown is closed, without claiming verification
  // merely because Private was selected.
  const verification = useConfidentialVerification(preference.verification);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () => {
      preference.load().then(value => { if (active) { setMode(value); setError(""); } })
        .catch(() => { if (active) { setMode(null); setError(ui("Could not read your AI choice. Select it again.")); } });
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
  const choose = async (next: WorkflowModelMode) => {
    setBusy(true); setError("");
    try { await preference.save(next); setMode(next); setOpen(false); trigger.current?.focus(); }
    catch { setError(ui("Could not save your AI choice. Try again.")); }
    finally { setBusy(false); }
  };
  return <div ref={root} className={styles.control} onKeyDown={event => {
    if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} type="button" className={styles.trigger} aria-label={ui("Workflows AI")} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
      disabled={busy} onClick={() => setOpen(!open)} onKeyDown={event => {
        if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOpen(true); }
      }}>
      {mode === "private" ? <Shield size={15} aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
      <span>{busy ? ui("Saving…") : mode ? uiMessages(WORKFLOW_MODELS[mode].label) : ui("Choose AI")}</span><ChevronDown size={13} aria-hidden="true" />
    </button>
    {open && <div ref={menu} id={menuId} className={styles.menu} role="menu" aria-label={ui("Workflows AI")} onKeyDown={event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || (event.target as HTMLElement).closest("dialog")) return;
      event.preventDefault();
      const choices = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')).filter(button => !button.closest("dialog"));
      const index = choices.indexOf(document.activeElement as HTMLButtonElement);
      choices[event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + choices.length) % choices.length]?.focus();
    }}>
      {Object.entries(WORKFLOW_MODELS).map(([key, value]) => <button type="button" key={key} role="menuitemradio" aria-checked={mode === key} disabled={busy} onClick={() => void choose(key as WorkflowModelMode)}>
        {key === "private" ? <Shield size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
        <span><strong>{uiMessages(value.label)}</strong><small>{uiMessages(value.description)}</small></span>{mode === key && <Check size={15} aria-hidden="true" />}
      </button>)}
      {mode === "private" && <div className={styles.verification}><ConfidentialVerificationDetails current={verification} showLabel triggerRole="menuitem" /></div>}
      <p>Applies to new chats and workflow updates.</p>
    </div>}
    {error && <span role="alert" className={styles.error}>{error}</span>}
  </div>;
}
