// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { emit } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTauriEvent } from "@/lib/hooks/use-tauri-event";
import { useRetainedState } from "@/lib/hooks/use-retained-state";
import { localFetch } from "@/lib/api";

export interface StarredSession {
  id: string;
  start: string;
  end: string;
  revision: number;
  hd_requested: boolean;
  has_audio: boolean;
}
type SessionWrite = Omit<StarredSession, "has_audio">;

async function request(path: string, init?: RequestInit) {
  const response = await localFetch(path, init);
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "Could not save the session. Try again.");
  return result;
}
export async function exportStarredSession(session: StarredSession) {
  if (Date.parse(session.end) > Date.now())
    throw new Error("End the session before exporting.");
  const result = await request("/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Export whatever was actually captured; this never enables recording.
    body: JSON.stringify({
      start: session.start,
      end: session.end,
      include_audio: true,
    }),
  });
  if (typeof result.output_path !== "string" || !result.output_path)
    throw new Error("Export did not return a saved video.");
  return result.output_path as string;
}
export function sessionContext(session: StarredSession) {
  return `Inspect starred session ${session.id}: start_time=${session.start}, end_time=${session.end}. Search with starred_session_id=${session.id}. has_audio=${session.has_audio}. Use captured evidence; pauses and exclusions may leave gaps.`;
}

export function useStarredSessions() {
  // Retained so the strip's chips don't pop in on every visit to Timeline.
  // `ready` stays per mount: it gates actions and the cross-window state emit
  // on a fresh load.
  const [sessions, setSessions] = useRetainedState<StarredSession[]>(
    "starredSessions:list",
    [],
  );
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const lock = useRef(false);
  const generation = useRef(0);
  const pending = useRef<SessionWrite | null>(null);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    const epoch = generation.current;
    const result = await request("/starred-sessions?limit=100");
    if (!Array.isArray(result.data))
      throw new Error("Could not read starred sessions.");
    if (mounted.current && generation.current === epoch) {
      setSessions(result.data);
      setNow(Date.now());
      setReady(true);
      if (!pending.current) setError(null);
    }
  }, [setSessions]);
  useEffect(() => {
    mounted.current = true;
    const load = () => {
      if (!lock.current)
        void refresh().catch((e) => {
          if (mounted.current) setError(e.message);
        });
    };
    load();
    const timer = setInterval(load, 5000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    window.addEventListener("focus", load);
    window.addEventListener("starred-sessions-changed", load);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      clearInterval(clock);
      window.removeEventListener("focus", load);
      window.removeEventListener("starred-sessions-changed", load);
    };
  }, [refresh]);
  useTauriEvent("starred-sessions-changed", () => {
    if (!lock.current) void refresh().catch((e) => {
      if (mounted.current) setError(e.message);
    });
  });
  const active = sessions.find(
    (s) => Date.parse(s.start) <= now && Date.parse(s.end) > now,
  );
  useEffect(() => {
    if (ready) void emit("starred-session-state", active?.end ?? null).catch(() => {});
  }, [ready, active?.end]);
  async function save(value: SessionWrite) {
    if (lock.current) return false;
    lock.current = true;
    generation.current++;
    setBusy(true);
    setError(null);
    pending.current = value;
    try {
      const result: StarredSession = await request("/starred-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      pending.current = null;
      if (mounted.current) {
        setSessions((rows) =>
          [result, ...rows.filter((s) => s.id !== result.id)].sort((a, b) =>
            b.start.localeCompare(a.start),
          ),
        );
        setNow(Date.now());
      }
      window.dispatchEvent(new Event("starred-sessions-changed"));
      return true;
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error ? e.message : "Could not save the session.",
        );
      await refresh().catch(() => {});
      return false;
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const start = (minutes: number, hd = false) => {
    const at = Date.now();
    return save({
      id: crypto.randomUUID(),
      start: new Date(at).toISOString(),
      end: new Date(at + minutes * 60000).toISOString(),
      hd_requested: hd,
      revision: 0,
    });
  };
  const end = () =>
    active
      ? save({
          ...active,
          end: new Date(
            Math.max(Date.now(), Date.parse(active.start) + 1),
          ).toISOString(),
        })
      : Promise.resolve(false);
  return {
    sessions,
    active,
    ready,
    busy,
    error,
    now,
    start,
    end,
    save,
    retry: () =>
      pending.current
        ? save(pending.current)
        : refresh()
            .then(() => true)
            .catch(() => false),
    refresh,
  };
}
