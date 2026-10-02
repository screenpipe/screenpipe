// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useSourceScreenshot } from "./use-source-screenshot";
import type { WorkflowsPlatform } from "./platform";
import styles from "./workflow-guide.module.css";

export function SourceSopScreenshot({ stage, load, title, alt }: {
  stage: Parameters<typeof useSourceScreenshot>[0];
  load: NonNullable<WorkflowsPlatform["guides"]>["loadSourceScreenshot"];
  title: string;
  alt?: string;
}) {
  const source = useSourceScreenshot(stage, false, load);
  return <figure ref={source.ref}>
    {source.image ? <img src={source.image.dataUrl} alt={alt ?? `Source for ${title}`} loading="lazy" draggable={false} />
      : <p className={styles.muted} role="status">{source.status === "loading" ? "Loading screenshot…" : "No captured screenshot available for this step."}
        {source.canRetry && source.status !== "loading" && <button onClick={source.retry}>Try again</button>}
      </p>}
  </figure>;
}
