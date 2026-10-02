// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { showChatWithPrefill } from "@/lib/chat-utils";
import {
  exportStarredSession,
  sessionContext,
  type StarredSession,
  type useStarredSessions,
} from "./use-starred-sessions";

const localTime = (iso: string) => {
  const at = new Date(iso);
  return new Date(at.getTime() - at.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
};
export function StarredSessionPanel({
  state,
  inDialog = false,
}: {
  state: ReturnType<typeof useStarredSessions>;
  inDialog?: boolean;
}) {
  const [selected, setSelected] = useState<string>();
  const [hd, setHd] = useState(false);
  const [starting, setStarting] = useState(false);
  type TimeEdit = { session: StarredSession; key: "start" | "end" };
  const [editing, setEditing] = useState<TimeEdit | null>(null);
  const editRef = useRef<TimeEdit | null>(null);
  const timeButtons = useRef<
    Partial<Record<"start" | "end", HTMLButtonElement | null>>
  >({});
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [video, setVideo] = useState<{ id: string; path: string } | null>(null);
  const closeEditor = (focus = false) => {
    const key = editRef.current?.key;
    editRef.current = null;
    setEditing(null);
    setError(null);
    if (focus && key)
      requestAnimationFrame(() => timeButtons.current[key]?.focus());
  };
  async function saveTime(edit: TimeEdit, value: string, focus = false) {
    // Enter can be followed by blur. Claim this draft once before saving.
    if (editRef.current !== edit) return;
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) {
      setError("Enter a valid date and time.");
      return;
    }
    const next = { ...edit.session, [edit.key]: date.toISOString() };
    if (Date.parse(next.end) <= Date.parse(next.start)) {
      setError("End time must be after start time.");
      return;
    }
    if (
      date.getTime() ===
      Math.floor(Date.parse(edit.session[edit.key]) / 1000) * 1000
    ) {
      closeEditor(focus);
      return;
    }
    editRef.current = null;
    setError(null);
    if (await state.save(next)) {
      setEditing(null);
      setVideo(null);
      if (focus)
        requestAnimationFrame(() => timeButtons.current[edit.key]?.focus());
    } else {
      editRef.current = edit;
    }
  }
  const session =
    state.sessions.find((s) => s.id === selected) ??
    state.active ??
    state.sessions[0];
  const completed = session && Date.parse(session.end) <= state.now;
  const showSession = session && !starting;
  const active = showSession && session.id === state.active?.id;
  const timeLabel = (iso: string) =>
    new Date(iso).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  const sameDay =
    session &&
    new Date(session.start).toDateString() ===
      new Date(session.end).toDateString();
  const action =
    "rounded-md border border-white/30 px-2 py-1.5 hover:bg-white/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 disabled:opacity-50";
  const disabled = !state.ready || state.busy || working;
  async function run(fn: () => Promise<unknown>) {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not complete this action.",
      );
    } finally {
      setWorking(false);
    }
  }
  return (
    <section
      aria-label="Starred work sessions"
      className="w-full rounded-lg bg-black p-3 text-xs text-white/90"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className={`flex items-center justify-between gap-2 ${inDialog ? "pr-8" : ""}`}>
        <p className="font-medium">
          {active
            ? `${Math.max(1, Math.ceil((Date.parse(session.end) - state.now) / 60000))} min left`
            : showSession
              ? "Starred session"
              : "Star for"}
          {active && session.hd_requested && <span className="ml-2 text-white/50" title="HD requested for this session">HD</span>}
        </p>
        {starting && session && <button className={action} disabled={disabled} onClick={() => setStarting(false)}>Cancel</button>}
        {active && (
          <button
            className={action}
            disabled={disabled}
            onClick={() => void state.end()}
          >
            End session
          </button>
        )}
      </div>
      {!showSession && (
        <div className="mt-3 grid grid-cols-4 gap-1" aria-label="Star for">
          {[5, 15, 30, 60].map((minutes) => (
            <button
              key={minutes}
              className={action}
              disabled={disabled}
              onClick={() =>
                void state.start(minutes, hd).then((saved) => {
                  if (saved) {
                    setSelected(undefined);
                    setStarting(false);
                  }
                })
              }
            >
              {minutes} min
            </button>
          ))}
        </div>
      )}
      {state.error && (
        <div role="alert" className="mt-2">
          {state.error}{" "}
          <button
            className={action}
            disabled={state.busy || working}
            onClick={() => void state.retry().then((saved) => {
              if (saved && starting) { setSelected(undefined); setStarting(false); }
            })}
          >
            Retry save
          </button>
        </div>
      )}
      {showSession && (
        <div className="mt-3 space-y-2">
          {new Date(session.start).toDateString() !==
            new Date(state.now).toDateString() && (
            <p className="text-white/50">
              {new Date(session.start).toLocaleDateString()}
            </p>
          )}
          <div className="space-y-1">
            {(["start", "end"] as const).map((key) => (
              <div
                key={key}
                className="grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-2"
              >
                <span className="capitalize text-white/50">{key}</span>
                {editing?.key === key ? (
                  <input
                    aria-label={`Session ${key}`}
                    type="datetime-local"
                    step="1"
                    required
                    autoFocus
                    disabled={disabled}
                    className="min-w-0 w-full rounded border border-white/40 bg-black px-1 py-1 text-xs [color-scheme:dark] focus:outline focus:outline-1 focus:outline-white/60"
                    defaultValue={localTime(editing.session[key])}
                    onBlur={(e) =>
                      void saveTime(editing, e.currentTarget.value)
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        closeEditor(true);
                      } else if (e.key === "Enter") {
                        e.preventDefault();
                        e.stopPropagation();
                        void saveTime(editing, e.currentTarget.value, true);
                      }
                    }}
                  />
                ) : (
                  <button
                    ref={(element) => {
                      timeButtons.current[key] = element;
                    }}
                    type="button"
                    aria-label={`Edit session ${key}`}
                    title={`Edit ${key} time`}
                    disabled={disabled}
                    className="rounded px-1 py-1 text-left tabular-nums text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/60 disabled:opacity-50"
                    onClick={() => {
                      const edit = { session: { ...session }, key };
                      editRef.current = edit;
                      setEditing(edit);
                      setError(null);
                    }}
                  >
                    {sameDay
                      ? timeLabel(session[key])
                      : new Date(session[key]).toLocaleString()}
                  </button>
                )}
              </div>
            ))}
          </div>
          {active && (
            <button
              className="rounded px-1 py-1 text-white/60 hover:bg-white/10 hover:text-white focus-visible:outline"
              disabled={disabled}
              onClick={() =>
                void state.save({
                  ...session,
                  end: new Date(
                    Date.parse(session.end) + 15 * 60000,
                  ).toISOString(),
                })
              }
            >
              +15 min
            </button>
          )}
        </div>
      )}
      <details className="mt-3 text-white/60">
        <summary className="w-fit cursor-pointer rounded py-1 hover:text-white focus-visible:outline">
          More
        </summary>
        <div className="mt-2 space-y-3">
          <label className="flex items-center justify-between gap-2">
            Capture
            <select
              aria-label={
                active
                  ? "Active session capture quality"
                  : "Session capture quality"
              }
              className="rounded-md border border-white/30 bg-black p-1"
              disabled={disabled || Boolean(showSession && !active)}
              value={
                (showSession ? session.hd_requested : hd) ? "hd" : "normal"
              }
              onChange={(e) =>
                active
                  ? void state.save({
                      ...session,
                      hd_requested: e.target.value === "hd",
                    })
                  : setHd(e.target.value === "hd")
              }
            >
              <option value="normal">Current settings</option>
              <option value="hd">HD for this session</option>
            </select>
          </label>
          {state.sessions.length > 1 && (
            <select
              aria-label="Saved session"
              className="block w-full rounded-md border border-white/30 bg-black p-1.5"
              value={session?.id}
              disabled={disabled}
              onChange={(e) => {
                setSelected(e.target.value);
                setStarting(false);
                closeEditor();
              }}
            >
              {state.sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {new Date(s.start).toLocaleString()}
                </option>
              ))}
            </select>
          )}
          {showSession && !state.active && (
            <button
              className={action}
              disabled={disabled}
              onClick={() => {
                closeEditor();
                setStarting(true);
              }}
            >
              New session
            </button>
          )}
          {showSession && !editing && (
            <div className="flex flex-wrap gap-2">
              {completed && (
                <button
                  className={action}
                  disabled={disabled}
                  onClick={() =>
                    void run(async () =>
                      setVideo({
                        id: session.id,
                        path: await exportStarredSession(session),
                      }),
                    )
                  }
                >
                  {working ? "Exporting…" : "Export video"}
                </button>
              )}
              <button
                className={action}
                disabled={disabled}
                onClick={() =>
                  void run(() =>
                    showChatWithPrefill({
                      context: sessionContext(session),
                      prompt:
                        "Describe this starred work session, citing captured evidence.",
                      autoSend: false,
                      source: "starred-session",
                    }),
                  )
                }
              >
                Ask about session
              </button>
            </div>
          )}
          {showSession && video?.id === session.id && (
            <button
              className={action}
              disabled={disabled}
              onClick={() => void run(() => revealItemInDir(video.path))}
            >
              Show saved video
            </button>
          )}
        </div>
      </details>
      {error && (
        <p role="alert" className="mt-2">
          {error}
        </p>
      )}
    </section>
  );
}
