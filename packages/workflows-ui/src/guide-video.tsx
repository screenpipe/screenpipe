// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Film, Loader2, Download, X } from "lucide-react";
import type { WorkflowGuide } from "./guide";
import type { WorkflowMap } from "./model";
import type { WorkflowsPlatform } from "./platform";
import styles from "./workflow-guide.module.css";
type Video = {
  url: string;
  export: () => Promise<boolean>;
  dispose: () => void;
};
export function GuideVideo({
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
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [images, setImages] = useState(false);
  const [video, setVideo] = useState<Video | null>(null);
  const controller = useRef<AbortController>();
  const currentVideo = useRef<Video | null>(null);
  const currentGuide = useRef(guide);
  currentGuide.current = guide;
  const renderedGuide = useRef<WorkflowGuide>();
  useEffect(
    () => () => {
      controller.current?.abort();
      currentVideo.current?.dispose();
    },
    [],
  );
  async function run(kind: "edit" | "render") {
    const run = new AbortController();
    controller.current = run;
    setBusy(true);
    setError("");
    setProgress(kind === "edit" ? "Editing your guide" : "Starting your video");
    const snapshot = guide;
    const report = (message: string) => {
      if (!run.signal.aborted) setProgress(message);
    };
    try {
      if (kind === "edit" && platform.edit) {
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
            "The guide changed while the assistant was editing. Your edits were kept. Try again.",
          );
        update(next);
        setRequest("");
      } else if (platform.video) {
        const result = await platform.video.render(
          snapshot,
          workflow,
          images,
          run.signal,
          report,
        );
        if (run.signal.aborted) {
          result.dispose();
          return;
        }
        currentVideo.current?.dispose();
        currentVideo.current = result;
        renderedGuide.current = snapshot;
        setVideo(result);
      }
    } catch (e) {
      if (!run.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : "Could not finish. Your guide is saved.",
        );
    } finally {
      if (!run.signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      className={styles.videoPanel}
      aria-label="Guide assistant and video"
    >
      {platform.edit && (
        <form
          className={styles.guideComposer}
          onSubmit={(e) => {
            e.preventDefault();
            if (request.trim() && !busy) void run("edit");
          }}
        >
          <input
            aria-label="Ask Screenpipe to edit the guide"
            placeholder="Ask Screenpipe to shorten, explain, or rewrite this guide…"
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
      {platform.video && (
        <>
          <button
            aria-expanded={open}
            disabled={busy}
            onClick={() => setOpen(!open)}
          >
            <Film size={16} />{" "}
            {open ? "Hide video script" : "Create a short video"}
          </button>
          {open && (
            <div className={styles.videoScript}>
              <h2>Review your video</h2>
              <p>
                One scene per step, with captions and an AI voice. Edit the
                script before recording.
              </p>
              {guide.steps.map((s, i) => (
                <label key={i}>
                  <span>
                    {String(i + 1).padStart(2, "0")} · {s.title}
                  </span>
                  <textarea
                    aria-label={`Scene ${i + 1} narration`}
                    disabled={busy}
                    maxLength={800}
                    value={s.narration ?? s.instruction}
                    onChange={(e) =>
                      update({
                        ...guide,
                        steps: guide.steps.map((step, j) =>
                          j === i
                            ? { ...step, narration: e.target.value }
                            : step,
                        ),
                      })
                    }
                  />
                </label>
              ))}
              <label className={styles.videoImages}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={images}
                  onChange={(e) => setImages(e.target.checked)}
                />{" "}
                Include the guide’s selected screenshots
              </label>
              <small>
                Narration text is sent to ElevenLabs through Screenpipe. Images
                are assembled on this device. Nothing is published.
              </small>
              {!busy && (
                <button
                  className={styles.primary}
                  onClick={() => void run("render")}
                >
                  <Film size={16} />
                  {video ? "Render again" : "Create video"}
                </button>
              )}
            </div>
          )}
        </>
      )}
      {busy && (
        <div className={styles.videoProgress} role="status">
          <Loader2 className={styles.spin} size={16} />
          <span>{progress}</span>
          <button
            onClick={() => {
              controller.current?.abort();
              setBusy(false);
              setError("Stopped. Your guide is saved.");
            }}
          >
            <X size={14} />
            Stop
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {video && (
        <div className={styles.videoPreview}>
          <video
            controls
            preload="metadata"
            src={video.url}
            aria-label="Guide video preview"
          />
          {renderedGuide.current !== guide && (
            <p>
              The guide has changed. Render again to include your latest edits.
            </p>
          )}
          <button
            onClick={async () => {
              try {
                await video.export();
              } catch {
                setError("Could not export the video. Try again.");
              }
            }}
          >
            <Download size={16} />
            Export MP4
          </button>
        </div>
      )}
    </section>
  );
}
