// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  Download,
  ExternalLink,
  ImageOff,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { WorkflowMap } from "./model";
import type { WorkflowsPlatform } from "./platform";
import {
  guideHtml,
  guideImage,
  guideSourceImage,
  type WorkflowGuide as Guide,
} from "./guide";
import { WorkflowRichText } from "./rich-text";
import { SopDocument } from "./sop-document";
import { GuideAssistant } from "./guide-assistant";
import styles from "./workflow-guide.module.css";
import { useGT } from "gt-react";

export function WorkflowGuide({
  workflow,
  platform,
  close,
}: {
  workflow: WorkflowMap;
  platform: NonNullable<WorkflowsPlatform["guides"]>;
  close: () => void;
}) {
  const ui = useGT();
  const [promptRequest, setPromptRequest] = useState<{
    id: string;
    text: string;
  }>();
  const [draft, setDraft] = useState<Guide | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [editing, setEditing] = useState(false);
  const [images, setImages] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [openingWeb, setOpeningWeb] = useState(false);
  const [webReview, setWebReview] = useState(false);
  const [webError, setWebError] = useState("");
  const [exportError, setExportError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const latest = useRef<Guide | null>(null);
  const saveVersion = useRef(0);
  const loadVersion = useRef(0);
  const mounted = useRef(true);
  async function persist(next: Guide) {
    const version = ++saveVersion.current;
    setSaved("Saving…");
    try {
      await platform.save(next);
      if (mounted.current && version === saveVersion.current)
        setSaved("Saved on this device");
    } catch (cause) {
      if (mounted.current && version === saveVersion.current)
        setSaved("Could not save. Retry before leaving.");
      throw cause;
    }
  }
  function update(next: Guide) {
    latest.current = next;
    setDraft(next);
    void persist(next).catch(() => {});
  }
  async function openGuide() {
    const version = ++loadVersion.current;
    setBusy(true);
    setError("");
    try {
      const existing = await platform.load(workflow);
      if (version !== loadVersion.current) return;
      if (existing) {
        latest.current = existing;
        setDraft(existing);
        setSaved("Saved on this device");
        setBusy(false);
      } else {
        setBusy(false);
        setPromptRequest({
          id: crypto.randomUUID(),
          text: `Create an SOP for ${workflow.title} from its available evidence. Keep missing details as questions and save the draft for review.`,
        });
      }
    } catch {
      if (version === loadVersion.current) {
        setError(
          ui("Your saved guide could not be opened. Its files are unchanged."),
        );
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void openGuide();
    return () => {
      loadVersion.current++;
      mounted.current = false;
    };
  }, []);
  function jump(event: MouseEvent<HTMLAnchorElement>) {
    // The host uses the URL hash for workflow navigation. Keep section links local.
    event.preventDefault();
    document
      .getElementById(event.currentTarget.hash.slice(1))
      ?.scrollIntoView({ block: "start" });
  }
  const stale = draft && draft.sourceRevision !== (workflow.revision ?? 0);
  function lines(
    label: string,
    key: "prerequisites" | "exceptions" | "completion" | "questions",
    placeholder: string,
  ) {
    if (!draft) return null;
    return (
      <section className={styles.section} id={`guide-${key}`}>
        <h2>{label}</h2>
        {editing ? (
          <textarea
            aria-label={label}
            placeholder={placeholder}
            value={draft[key].join("\n")}
            onChange={(e) =>
              update({ ...draft, [key]: e.target.value.split("\n") })
            }
          />
        ) : draft[key].filter(Boolean).length ? (
          <ul>
            {draft[key].filter(Boolean).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className={styles.muted}>{placeholder}</p>
        )}
      </section>
    );
  }
  return (
    <div className={styles.guide}>
      <header className={styles.toolbar}>
        <button
          onClick={() => {
            close();
          }}
        >
          <ArrowLeft size={16} />
          Back to workflow
        </button>
        <div>
          <span role="status" className={styles.saveStatus} title={saved}>
            {saved.startsWith("Could not") ? (
              saved
            ) : (
              <>
                {saved === "Saving…" ? (
                  <Loader2
                    size={16}
                    className={styles.spin}
                    aria-hidden="true"
                  />
                ) : saved ? (
                  <Check size={16} aria-hidden="true" />
                ) : null}
                <span className={styles.srOnly}>{saved}</span>
              </>
            )}
          </span>
          {draft && saved.startsWith("Could not") && (
            <button
              onClick={() =>
                latest.current && void persist(latest.current).catch(() => {})
              }
            >
              Retry save
            </button>
          )}
          {draft && (
            <>
              {platform.openWeb && (
                <button
                  className={styles.iconButton}
                  aria-label={ui("Open web editor")}
                  title={ui("Open web editor")}
                  onClick={() => {
                    setWebReview(true);
                    setWebError("");
                  }}
                >
                  <ExternalLink size={18} aria-hidden="true" />
                </button>
              )}
              <button
                className={styles.iconButton}
                aria-label={editing ? ui("Done editing") : ui("Edit SOP")}
                title={editing ? ui("Done editing") : ui("Edit SOP")}
                aria-pressed={editing}
                onClick={() => setEditing(!editing)}
              >
                {editing ? (
                  <Check size={18} aria-hidden="true" />
                ) : (
                  <Pencil size={18} aria-hidden="true" />
                )}
              </button>
              <button
                className={styles.iconButton}
                aria-label={ui("Export SOP")}
                title={ui("Export SOP")}
                onClick={() => {
                  setImages(false);
                  setExportError("");
                  dialog.current?.showModal();
                }}
              >
                <Download size={18} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </header>
      {!busy && !error && (
        <GuideAssistant
          guide={draft}
          workflow={workflow}
          platform={platform}
          promptRequest={promptRequest}
          update={async (next) => {
            await persist(next);
            if (!mounted.current) return;
            latest.current = next;
            setDraft(next);
          }}
        />
      )}
      {draft && webReview && (
        <section
          className={styles.section}
          aria-label={ui("Open SOP on the web")}
        >
          <h2>Open your SOP on the web</h2>
          <p>
            Save the reviewed SOP text to your Screenpipe account to edit and
            share it. Recordings and screenshots stay on this device. Existing
            web edits are preserved when you reopen.
          </p>
          {webError && <p role="alert">{webError}</p>}
          <button
            disabled={openingWeb}
            onClick={async () => {
              setOpeningWeb(true);
              setWebError("");
              try {
                await platform.openWeb?.(draft);
                setWebReview(false);
              } catch (e) {
                setWebError(
                  e instanceof Error ? e.message : "Could not open SOP",
                );
              } finally {
                setOpeningWeb(false);
              }
            }}
          >
            {openingWeb ? ui("Opening…") : ui("Continue to web editor")}
          </button>
          <button disabled={openingWeb} onClick={() => setWebReview(false)}>
            Cancel
          </button>
        </section>
      )}
      {!draft ? (
        <SopDocument title={workflow.title} subtitle="Draft for review">
          <p role="status">
            {busy
              ? "Opening SOP…"
              : "Your SOP will appear here as you work with the assistant."}
          </p>
          {error && <p role="alert">{error}</p>}
          {error && <button onClick={() => void openGuide()}>Try again</button>}
        </SopDocument>
      ) : (
        <div className={styles.layout}>
          <aside className={styles.outline}>
            <p className={styles.eyebrow}>IN THIS GUIDE</p>
            <a onClick={jump} href="#guide-prerequisites">
              Before you start
            </a>
            {draft.steps.map((step, i) => (
              <a onClick={jump} href={`#guide-step-${i}`} key={i}>
                <span>{String(i + 1).padStart(2, "0")}</span>
                {step.title || ui("Untitled step")}
              </a>
            ))}
            <a onClick={jump} href="#guide-completion">
              Check your result
            </a>
            <div className={styles.note}>
              <BookOpen size={18} />
              <p>A draft for your team</p>
              <small>
                Review the steps and remove sensitive information before
                sharing.
              </small>
            </div>
          </aside>
          <SopDocument
            title={draft.title}
            onTitleChange={
              editing ? (title) => update({ ...draft, title }) : undefined
            }
            subtitle={<>{draft.steps.length} steps · Draft for review</>}
          >
            {editing ? (
              <textarea
                aria-label="Guide summary"
                value={draft.summary}
                onChange={(event) =>
                  update({ ...draft, summary: event.target.value })
                }
              />
            ) : (
              <p>{draft.summary}</p>
            )}
            {stale && (
              <p className={styles.notice}>
                This workflow has changed since the SOP was drafted. Your edits
                are preserved. Screenshots are unavailable until the SOP is
                reconciled with the new revision.
              </p>
            )}
            {lines(
              "Before you start",
              "prerequisites",
              "No prerequisites confirmed yet. Add the information someone needs before starting.",
            )}
            <div className={styles.steps}>
              {draft.steps.map((step, i) => {
                const image =
                  !stale && step.includeImage
                    ? guideImage(workflow, step.sourceStage, step.imageReview)
                    : null;
                const source = !stale
                  ? guideSourceImage(workflow, step.sourceStage)
                  : null;
                return (
                  <section
                    className={styles.step}
                    key={i}
                    id={`guide-step-${i}`}
                  >
                    <div className={styles.stepHeading}>
                      <span className={styles.number}>{i + 1}</span>
                      {editing ? (
                        <input
                          aria-label={ui("Step {value1} title", {
                            value1: i + 1,
                          })}
                          value={step.title}
                          onChange={(e) =>
                            update({
                              ...draft,
                              steps: draft.steps.map((s, j) =>
                                j === i ? { ...s, title: e.target.value } : s,
                              ),
                            })
                          }
                        />
                      ) : (
                        <h2>{step.title}</h2>
                      )}
                      {editing && (
                        <div className={styles.stepTools}>
                          <button
                            aria-label={ui("Move step {value1} up", {
                              value1: i + 1,
                            })}
                            disabled={i === 0}
                            onClick={() => {
                              const steps = [...draft.steps];
                              [steps[i - 1], steps[i]] = [
                                steps[i],
                                steps[i - 1],
                              ];
                              update({ ...draft, steps });
                            }}
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            aria-label={ui("Move step {value1} down", {
                              value1: i + 1,
                            })}
                            disabled={i === draft.steps.length - 1}
                            onClick={() => {
                              const steps = [...draft.steps];
                              [steps[i + 1], steps[i]] = [
                                steps[i],
                                steps[i + 1],
                              ];
                              update({ ...draft, steps });
                            }}
                          >
                            <ArrowDown size={14} />
                          </button>
                          <button
                            aria-label={ui("Remove step {value1}", {
                              value1: i + 1,
                            })}
                            disabled={draft.steps.length === 1}
                            onClick={() =>
                              update({
                                ...draft,
                                steps: draft.steps.filter((_, j) => j !== i),
                              })
                            }
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                    <WorkflowRichText
                      value={step.instruction}
                      label={ui("Step {value1} instructions", {
                        value1: i + 1,
                      })}
                      fullDocument
                      onChange={
                        editing
                          ? (instruction) =>
                              update({
                                ...draft,
                                steps: draft.steps.map((step, index) =>
                                  index === i ? { ...step, instruction } : step,
                                ),
                              })
                          : undefined
                      }
                    />
                    {image ? (
                      <figure>
                        <img
                          src={image}
                          alt={ui("Source for {value1}", {
                            value1: step.title,
                          })}
                          draggable={false}
                        />
                        {editing && (
                          <button
                            onClick={() =>
                              update({
                                ...draft,
                                steps: draft.steps.map((s, j) =>
                                  j === i ? { ...s, includeImage: false } : s,
                                ),
                              })
                            }
                          >
                            <ImageOff size={14} />
                            Remove screenshot
                          </button>
                        )}
                      </figure>
                    ) : source ? (
                      <ScreenshotReview
                        key={`${step.sourceStage}:${source.dataUrl}`}
                        source={source}
                        title={step.title}
                        include={() => {
                          update({
                            ...draft,
                            steps: draft.steps.map((s, j) =>
                              j === i
                                ? {
                                    ...s,
                                    includeImage: true,
                                    imageReview: {
                                      frameId: source.frameId,
                                      timestamp: source.timestamp,
                                    },
                                  }
                                : s,
                            ),
                          });
                        }}
                      />
                    ) : (
                      <p className={styles.muted}>
                        {stale
                          ? ui(
                              "Source changed. Regenerate this SOP to review its screenshots.",
                            )
                          : ui("No captured screenshot for this step.")}
                      </p>
                    )}
                    {editing ? (
                      <label className={styles.result}>
                        Expected result
                        <input
                          aria-label={ui("Step {value1} expected result", {
                            value1: i + 1,
                          })}
                          value={step.expectedResult}
                          onChange={(e) =>
                            update({
                              ...draft,
                              steps: draft.steps.map((s, j) =>
                                j === i
                                  ? { ...s, expectedResult: e.target.value }
                                  : s,
                              ),
                            })
                          }
                        />
                      </label>
                    ) : (
                      step.expectedResult && (
                        <p className={styles.result}>
                          <Check size={15} />
                          {step.expectedResult}
                        </p>
                      )
                    )}
                  </section>
                );
              })}
            </div>
            {editing && draft.steps.length < 40 && (
              <button
                onClick={() =>
                  update({
                    ...draft,
                    steps: [
                      ...draft.steps,
                      {
                        title: ui("New step"),
                        instruction: "",
                        expectedResult: "",
                        sourceStage: null,
                        includeImage: false,
                      },
                    ],
                  })
                }
              >
                <Plus size={15} />
                Add step
              </button>
            )}
            {lines("Exceptions", "exceptions", "No exceptions confirmed yet.")}
            {lines(
              "Check your result",
              "completion",
              "Add a check that confirms the workflow is complete.",
            )}
            {lines(
              "Still to confirm",
              "questions",
              "No open questions in this draft.",
            )}
          </SopDocument>
        </div>
      )}
      <dialog ref={dialog} className={styles.exportDialog}>
        <div>
          <h2>Export your SOP</h2>
          <button
            aria-label={ui("Close export")}
            onClick={() => dialog.current?.close()}
          >
            <X size={18} />
          </button>
        </div>
        <p>
          A self-contained HTML document. Open it in a browser, share the file,
          or print it to PDF.
        </p>
        <label>
          <input
            type="checkbox"
            checked={images}
            disabled={Boolean(stale)}
            onChange={(e) => setImages(e.target.checked)}
          />
          Include screenshots I have reviewed
        </label>
        <small>
          Screenshots can contain customer information. Only the selected guide
          content is exported. Original audio and recordings are never attached.
        </small>
        {exportError && <p role="alert">{exportError}</p>}
        <button
          className={styles.primary}
          disabled={exporting || !draft?.title.trim()}
          onClick={async () => {
            if (!draft) return;
            setExporting(true);
            setExportError("");
            try {
              if (
                await platform.export(
                  guideHtml(draft, workflow, images),
                  draft.title,
                )
              )
                dialog.current?.close();
            } catch {
              setExportError(
                "Could not export. Your draft is still open here. Try again.",
              );
            } finally {
              setExporting(false);
            }
          }}
        >
          <Download size={15} />
          {exporting ? ui("Exporting…") : ui("Export HTML")}
        </button>
      </dialog>
    </div>
  );
}

function ScreenshotReview({
  source,
  title,
  include,
}: {
  source: NonNullable<ReturnType<typeof guideSourceImage>>;
  title: string;
  include: () => void;
}) {
  const ui = useGT();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className={styles.imageReview}>
      <div className={styles.imageReviewHeader}>
        <span>Saved screenshot available</span>
        <button aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? ui("Hide screenshot") : ui("Review screenshot")}
        </button>
      </div>
      {open && (
        <>
          <img
            src={source.dataUrl}
            alt={ui("Review source for {value1}", { value1: title })}
            draggable={false}
            onLoad={() => {
              setLoaded(true);
              setFailed(false);
            }}
            onError={() => {
              setFailed(true);
              setLoaded(false);
            }}
          />
          <div className={styles.imageReviewHeader}>
            <span>
              {failed
                ? ui("This screenshot could not be loaded.")
                : ui("Does this image show the step clearly?")}
            </span>
            <button disabled={!loaded || failed} onClick={include}>
              Include screenshot
            </button>
          </div>
        </>
      )}
    </div>
  );
}
