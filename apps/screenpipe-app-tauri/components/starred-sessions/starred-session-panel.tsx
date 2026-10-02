// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { useState } from "react";
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
}: {
  state: ReturnType<typeof useStarredSessions>;
}) {
  const [selected, setSelected] = useState<string>();
  const [hd, setHd] = useState(false);
  const [editing, setEditing] = useState<StarredSession | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [video, setVideo] = useState<{ id: string; path: string } | null>(null);
  const session =
    state.sessions.find((s) => s.id === selected) ??
    state.active ??
    state.sessions[0];
  const completed = session && Date.parse(session.end) <= state.now;
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
      className="w-full rounded-lg border border-white/25 bg-black p-3 text-xs text-white/90"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <p className="font-medium">
        {state.active ? "Starring this session" : "Star a work session"}
      </p>
      <p className="my-2 text-white/60">
        Keep an important stretch of work easy to find.
      </p>
      {state.active ? (
        <div className="space-y-2">
          <label className="flex items-center justify-between gap-2">
            Capture
            <select
              aria-label="Active session capture quality"
              className="rounded-md border border-white/30 bg-black p-1"
              disabled={disabled}
              value={state.active.hd_requested ? "hd" : "normal"}
              onChange={(e) =>
                void state.save({
                  ...state.active!,
                  hd_requested: e.target.value === "hd",
                })
              }
            >
              <option value="normal">Current settings</option>
              <option value="hd">HD for this session</option>
            </select>
          </label>
          <p aria-live="off">
            {Math.max(
              1,
              Math.ceil((Date.parse(state.active.end) - state.now) / 60000),
            )}{" "}
            min left ·{" "}
            {state.active.hd_requested
              ? "HD requested"
              : "Current capture settings"}
          </p>
          <div className="flex gap-2">
            <button
              className={action}
              disabled={disabled}
              onClick={() => void state.end()}
            >
              End session
            </button>
            <button
              className={action}
              disabled={disabled}
              onClick={() =>
                void state.save({
                  ...state.active!,
                  end: new Date(
                    Date.parse(state.active!.end) + 15 * 60000,
                  ).toISOString(),
                })
              }
            >
              +15 min
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-1" aria-label="Star for">
            {[5, 15, 30, 60].map((minutes) => (
              <button
                key={minutes}
                className={action}
                disabled={disabled}
                onClick={() => void state.start(minutes, hd)}
              >
                {minutes} min
              </button>
            ))}
          </div>
          <label className="mt-2 flex items-center justify-between gap-2">
            Capture
            <select
              aria-label="Session capture quality"
              value={hd ? "hd" : "normal"}
              onChange={(e) => setHd(e.target.value === "hd")}
              className="rounded-md border border-white/30 bg-black p-1"
              disabled={disabled}
            >
              <option value="normal">Current settings</option>
              <option value="hd">HD for this session</option>
            </select>
          </label>
          <p className="mt-2 text-white/50">
            Recording pauses and exclusions still apply.
          </p>
        </>
      )}
      {state.error && (
        <div role="alert" className="mt-2">
          {state.error}{" "}
          <button
            className={action}
            disabled={state.busy || working}
            onClick={() => void state.retry()}
          >
            Retry save
          </button>
        </div>
      )}
      {session && (
        <div className="mt-3 space-y-2 border-t border-white/20 pt-2">
          <label className="block">
            Sessions
            <select
              aria-label="Saved session"
              className="mt-1 block w-full rounded-md border border-white/30 bg-black p-1.5"
              value={session.id}
              disabled={disabled}
              onChange={(e) => {
                setSelected(e.target.value);
                setEditing(null);
                setError(null);
              }}
            >
              {state.sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {new Date(s.start).toLocaleString()} ·{" "}
                  {Math.max(
                    1,
                    Math.round(
                      (Date.parse(s.end) - Date.parse(s.start)) / 60000,
                    ),
                  )}{" "}
                  min
                </option>
              ))}
            </select>
          </label>
          <p className="text-white/60">
            {new Date(session.start).toLocaleTimeString()} –{" "}
            {new Date(session.end).toLocaleTimeString()} ·{" "}
            {session.has_audio ? "Recorded audio" : "Audio not found"}
          </p>
          {editing ? (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                const fields = new FormData(e.currentTarget);
                const start = new Date(String(fields.get("start")));
                const end = new Date(String(fields.get("end")));
                if (
                  !Number.isFinite(start.getTime()) ||
                  !Number.isFinite(end.getTime()) ||
                  end <= start
                ) {
                  setError("End time must be after start time.");
                  return;
                }
                void state
                  .save({
                    ...editing,
                    start: start.toISOString(),
                    end: end.toISOString(),
                  })
                  .then((saved) => {
                    if (saved) {
                      setEditing(null);
                      setVideo(null);
                      setError(null);
                    }
                  });
              }}
            >
              {(["start", "end"] as const).map((key) => (
                <label key={key} className="block capitalize">
                  {key}
                  <input
                    aria-label={`Session ${key}`}
                    type="datetime-local"
                    step="1"
                    required
                    className="mt-1 block w-full rounded-md border border-white/30 bg-black p-1.5"
                    name={key}
                    defaultValue={localTime(editing[key])}
                  />
                </label>
              ))}
              <div className="flex gap-2">
                <button className={action} disabled={disabled} type="submit">
                  Save times
                </button>
                <button
                  className={action}
                  type="button"
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                className={action}
                disabled={disabled}
                onClick={() => setEditing({ ...session })}
              >
                Edit times
              </button>
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
          {video?.id === session.id && (
            <button
              className={action}
              disabled={disabled}
              onClick={() => void run(() => revealItemInDir(video.path))}
            >
              Show saved video
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2">
          {error}
        </p>
      )}
    </section>
  );
}
