// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useId, useState } from "react";
import { guideScreenshot, guideSourceStage, isGuideImage, type WorkflowGuide } from "./guide";
import { reconnectGuideSources } from "./guide-video";
import type { WorkflowMap } from "./model";
import styles from "./workflow-guide.module.css";

export function GuideSourceReview({ guide, workflow, onApply }: {
  guide: WorkflowGuide; workflow: WorkflowMap; onApply: (guide: WorkflowGuide) => Promise<void>;
}) {
  const [sources, setSources] = useState(() => guide.steps.map(step => guideSourceStage(guide, step, workflow) ?? (step.sourceStage !== null && workflow.stages[step.sourceStage] ? step.sourceStage : null)));
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function apply() {
    setBusy(true); setError("");
    try { await onApply(reconnectGuideSources(guide, workflow, sources)); setExpanded(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the screenshot links. Try again."); }
    finally { setBusy(false); }
  }
  return <section className={styles.sourceReview} aria-label="Review screenshot links">
    <div className={styles.sourceReviewHeader}>
      <span>Screenshots changed</span>
      <button type="button" className={styles.sourceReviewToggle} aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(value => !value)}>
        {expanded ? "Close review" : "Review screenshots"}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" style={{ transform: expanded ? "rotate(180deg)" : undefined }}><path d="m6 9 6 6 6-6" /></svg>
      </button>
    </div>
    <div id={panelId} hidden={!expanded}>
    {expanded && <>
    <p className={styles.sourceReviewHint}>Choose a screenshot for each step. Your writing stays as it is.</p>
    {guide.steps.map((step, index) => {
      const image = guideScreenshot(workflow, sources[index], step.imageReview) ?? guideScreenshot(workflow, sources[index]);
      return <div className={styles.sourceReviewRow} key={index}>
        <label><strong>{index + 1}. {step.title}</strong><select aria-label={`Screenshot source for step ${index + 1}`} disabled={busy} value={sources[index] ?? "none"} onChange={event => setSources(previous => previous.map((value, i) => i === index ? event.target.value === "none" ? null : Number(event.target.value) : value))}>
          <option value="none">No screenshot source</option>
          {workflow.stages.map((stage, i) => <option key={i} value={i}>{i + 1}. {stage.name}</option>)}
        </select></label>
        {image && isGuideImage(image.dataUrl) && <img src={image.dataUrl} alt={`Proposed source for ${step.title}`} loading="lazy" />}
      </div>;
    })}
    {guide.video?.scenes.some(scene => scene.focus) && <p>Screenshot framing will reset. Your narration and scene order are preserved.</p>}
    {error && <p role="alert">{error}</p>}
    <div className={styles.sourceReviewActions}>
      <button type="button" className={styles.primary} disabled={busy} onClick={() => void apply()}>{busy ? "Saving…" : "Save screenshot choices"}</button>
    </div>
    </>}
    </div>
  </section>;
}
