// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useId, useRef, type ReactNode } from "react";
import { Share2, X } from "lucide-react";
import type { WorkflowSecondaryAction } from "./workflow-more-actions";
import styles from "./workflow-editor.module.css";

export type WorkflowShareOptions = {
  people: WorkflowSecondaryAction[];
  agents: WorkflowSecondaryAction[];
  renderAgents?: (close: () => void) => ReactNode;
};

export function WorkflowShareDialog({ title, options, exports }: {
  title: string;
  options: WorkflowShareOptions;
  exports: WorkflowSecondaryAction[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const close = () => dialog.current?.close();
  const actionButton = (action: WorkflowSecondaryAction) => (
    <button key={action.label} type="button" disabled={action.disabled} onClick={() => {
      close();
      action.onSelect();
    }}><action.icon size={16} aria-hidden="true" />{action.label}</button>
  );
  return <>
    <button type="button" className={styles.shareTrigger} aria-label="Share workflow" aria-haspopup="dialog"
      onClick={() => dialog.current?.showModal()}><Share2 size={16} aria-hidden="true" />Share</button>
    <dialog ref={dialog} className={styles.shareDialog} aria-labelledby={heading}
      onKeyDown={event => event.stopPropagation()}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
      }}>
      <header><h2 id={heading}>Share workflow</h2><button type="button" aria-label="Close sharing options" onClick={close}><X size={16} /></button></header>
      <p>{title}</p>
      <section><h3>For people</h3><div>{[...options.people, ...exports].map(actionButton)}</div></section>
      {(options.agents.length > 0 || options.renderAgents) && <section>
        <h3>For agents</h3><div>{options.agents.map(actionButton)}{options.renderAgents?.(close)}</div>
      </section>}
    </dialog>
  </>;
}
