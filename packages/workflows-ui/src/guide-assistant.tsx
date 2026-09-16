// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, X } from "lucide-react";
import type { WorkflowGuide } from "./guide";
import type { WorkflowMap } from "./model";
import type { WorkflowsPlatform } from "./platform";
import styles from "./workflow-guide.module.css";
export function GuideAssistant({
  guide,
  workflow,
  platform,
  update,
}: {
  guide: WorkflowGuide;
  workflow: WorkflowMap;
  platform: NonNullable<WorkflowsPlatform["guides"]>;
  update: (guide: WorkflowGuide) => void;
}) {
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController>();
  const currentGuide = useRef(guide);
  currentGuide.current = guide;
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  async function run() {
    const run = new AbortController();
    controller.current = run;
    setBusy(true);
    setError("");
    setProgress("Editing your SOP");
    const snapshot = guide;
    const report = (message: string) => {
      if (!run.signal.aborted) setProgress(message);
    };
    try {
      if (platform.edit) {
        const next = await platform.edit(
          snapshot,
          workflow,
          request,
          run.signal,
          report,
        );
        if (run.signal.aborted) return;
        if (currentGuide.current !== snapshot)
          throw new Error(
            "The SOP changed while the assistant was editing. Your edits were kept. Try again.",
          );
        update(next);
        setRequest("");
      }
    } catch (e) {
      if (!run.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : "Could not finish. Your SOP is saved.",
        );
    } finally {
      if (!run.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className={styles.assistantPanel} aria-label="SOP assistant">
      {platform.edit && (
        <form
          className={styles.guideComposer}
          onSubmit={(e) => {
            e.preventDefault();
            if (request.trim() && !busy) void run();
          }}
        >
          <input
            aria-label="Ask Screenpipe to edit the SOP"
            placeholder="Ask Screenpipe to shorten, explain, or rewrite this SOP…"
            value={request}
            maxLength={4000}
            disabled={busy}
            onChange={(e) => setRequest(e.target.value)}
          />
          <button
            aria-label="Edit with Screenpipe"
            disabled={busy || !request.trim()}
          >
            <ArrowUp size={17} />
          </button>
        </form>
      )}
      {busy && (
        <div className={styles.assistantProgress} role="status">
          <Loader2 className={styles.spin} size={16} />
          <span>{progress}</span>
          <button
            onClick={() => {
              controller.current?.abort();
              setBusy(false);
              setError("Stopped. Your SOP is saved.");
            }}
          >
            <X size={14} />
            Stop
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
