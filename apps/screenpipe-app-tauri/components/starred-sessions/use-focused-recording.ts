// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { useCallback, useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { refreshApiConfig, localFetch } from "@/lib/api";
import { useTauriEvent } from "@/lib/hooks/use-tauri-event";
import { FocusedNarration } from "./focused-narration";

export interface FocusedSession {
  id: string; name: string; phase: "recording" | "paused" | "summary" | "submitted" | "deleted";
  voiceEnabled: boolean; revision: number; createdAt: number; lastCaptureAt: number; captureUntil: number;
  intervals: { start: number; end: number | null }[];
  media: { screenFrames: number; audioSeconds: number; audioChunks: number } | null;
}
type Action = "pause" | "resume" | "finish" | "submit" | "delete" | "heartbeat";
class RecordingRequestError extends Error { constructor(message: string, public status: number) { super(message); } }
async function request(path: string, init?: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // Persisted settings can replace the port even after the native key loads.
    await refreshApiConfig();
    const response = await localFetch(path, { ...init, signal: controller.signal });
    const value = await response.json();
    if (!response.ok) throw new RecordingRequestError(value.error || "Could not save this recording. Try again.", response.status);
    return value;
  } finally { clearTimeout(timer); }
}
const json = (value: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });

export function useFocusedRecording({ canRecord, voiceAllowed }: { canRecord: boolean; voiceAllowed: boolean }) {
  const [session, setSession] = useState<FocusedSession | null>(null);
  const [name, setNameState] = useState("");
  const [hot, setHot] = useState(false);
  const hotRef = useRef(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const current = useRef<FocusedSession | null>(null);
  const nameRef = useRef("");
  const lock = useRef(false);
  const idle = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(false);
  const stoppedAt = useRef<number>();
  const pending = useRef<{ path: string; init: RequestInit }>();
  const [voice] = useState(() => new FocusedNarration(async chunk => {
    if (!chunk.recordingId) throw new Error("Recording is unavailable. Keep this window open and retry saving voice.");
    const query = new URLSearchParams({ stream_id: chunk.streamId, sequence: String(chunk.sequence), start: String(chunk.start), end: String(chunk.end) });
    await request(`/focused-recordings/${chunk.recordingId}/audio/${chunk.id}?${query}`, {
      method: "POST", headers: { "Content-Type": chunk.audio.type || "audio/webm" }, body: chunk.audio,
    });
  }, state => { hotRef.current = state.hot; if (mounted.current) { setHot(state.hot); if (state.error) setError(state.error); } }));

  const receive = useCallback((next: FocusedSession | null) => {
    const previous = current.current;
    if (previous && next?.id === previous.id && next.revision < previous.revision) return;
    if (previous?.phase === "recording" && next?.phase === "paused" && hotRef.current) {
      const at=Date.now();
      void voice.stop(at).catch(cause => { if (mounted.current) setError(String(cause)); });
      next={...next,intervals:next.intervals.map((interval,index)=> index===next!.intervals.length-1 && interval.end!==null ? {...interval,end:Math.max(interval.end,at)} : interval)};
    }
    if (previous && next?.id !== previous.id) void voice.stop().catch(cause => { if (mounted.current) setError(String(cause)); });
    if (next?.id !== previous?.id || (next?.phase === "recording" && previous?.phase !== "recording")) stoppedAt.current = undefined;
    current.current = next;
    if (!mounted.current) return;
    setSession(next); setNow(Date.now());
    if (!previous || next?.id !== previous.id || nameRef.current === previous.name) {
      nameRef.current = next?.name ?? ""; setNameState(nameRef.current);
    }
    void emit("focused-recording-state", next?.phase === "recording" ? new Date(next.captureUntil).toISOString() : null).catch(() => {});
  }, [voice]);
  const load = useCallback(async () => { receive(await request("/focused-recordings/current")); }, [receive]);
  const run = useCallback(async (operation: () => Promise<void>, quiet = false) => {
    if (lock.current) return;
    lock.current = true;
    let release!: () => void;
    idle.current = new Promise(resolve => { release = resolve; });
    setBusy(true); if (!quiet) setError(undefined);
    try { await operation(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not save this recording. Try again."); }
    finally { lock.current = false; release(); if (mounted.current) setBusy(false); }
  }, []);
  const performWrite = useCallback(async (write: { path: string; init: RequestInit }) => {
    try {
      const next = await request(write.path, write.init);
      pending.current = undefined; receive(next);
    } catch (cause) {
      if (cause instanceof RecordingRequestError && cause.status < 500) {
        pending.current = undefined;
        if (cause.status === 409) await load().catch(() => {});
      }
      throw cause;
    }
  }, [load, receive]);
  const send = useCallback(async (action: Record<string, unknown>) => {
    if (pending.current) throw new Error("Retry the previous save before continuing.");
    const value = current.current;
    if (!value) throw new Error("Recording is unavailable. Reload and try again.");
    const write = { path: `/focused-recordings/${value.id}/action`, init: json({ ...action, revision: value.revision, requestId: crypto.randomUUID() }) };
    pending.current = write;
    await performWrite(write);
  }, [performWrite]);
  const saveName = useCallback(async () => {
    if (current.current && nameRef.current !== current.current.name) await send({ action: "rename", name: nameRef.current });
  }, [send]);
  const act = useCallback(async (action: Action) => {
    // Stop resources even if a background write is still waiting on storage.
    if ((action === "pause" || action === "finish") && lock.current) {
      const value = current.current;
      const previousWrite = idle.current;
      if (!value || value.phase !== "recording") return;
      const at = stoppedAt.current ?? Date.now();
      stoppedAt.current = at; setNow(at);
      const closing = voice.stop(at);
      try {
        receive(await request(`/focused-recordings/${value.id}/action`, json({ action: "pause", at, revision: value.revision, requestId: crypto.randomUUID() })));
        await closing;
        if (action === "finish") {
          await previousWrite;
          if (current.current?.id === value.id) await run(async () => {
            await saveName();
            await send({ action: "finish" });
          });
        }
      } catch (cause) {
        await closing.catch(() => {});
        if (cause instanceof RecordingRequestError && cause.status === 409) await load().catch(() => {});
        setError(cause instanceof Error ? cause.message : "Recording stopped. Retry to save its state.");
      }
      return;
    }
    return run(async () => {
    if (action === "resume" && !canRecord) throw new Error("Recording is unavailable under your workspace policy.");
    if (action === "pause" || action === "finish") {
      const at = stoppedAt.current ?? Date.now();
      stoppedAt.current = at; setNow(at);
      // Freeze the screen interval and release the mic before awaiting disk.
      const closing = voice.stop(at);
      const pausing = current.current?.phase === "recording" ? send({ action: "pause", at }) : Promise.resolve();
      await Promise.all([closing, pausing]);
    } else if (action === "delete" || action === "submit") await voice.stop();
    if (action !== "heartbeat") await saveName();
    if (action !== "pause") await send({ action, ...(action === "delete" ? { confirmed: true } : {}) });
    if (action === "resume") { stoppedAt.current = undefined; setNow(Date.now()); }
  }, action === "heartbeat");
  }, [canRecord, load, receive, run, saveName, send, voice]);
  const retry = useCallback(() => run(async () => {
    await voice.flush();
    if (pending.current) {
      const write = pending.current;
      await performWrite(write);
    } else await load();
  }), [load, performWrite, run, voice]);
  const toggleVoice = useCallback(() => run(async () => {
    if (!voiceAllowed || !canRecord) throw new Error("Voice recording is unavailable under your workspace policy.");
    if (hot) { await voice.stop(); await send({ action: "voice", enabled: false }); }
    else {
      await send({ action: "voice", enabled: true });
      const value=current.current;
      if (value?.phase === "recording") await voice.start(value.id,()=>current.current?.id===value.id && current.current.phase==="recording" && Date.now()<current.current.captureUntil);
    }
  }), [canRecord, hot, run, send, voice, voiceAllowed]);
  const newWorkflow = useCallback(() => run(async () => {
    if (!canRecord) throw new Error("Recording is unavailable under your workspace policy.");
    await voice.stop();
    const write = { path: "/focused-recordings/start", init: json({ id: crypto.randomUUID() }) };
    pending.current = write;
    const next = await request(write.path, write.init);
    pending.current = undefined; receive(next);
  }), [canRecord, receive, run, voice]);

  useEffect(() => {
    mounted.current = true;
    void run(load);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { mounted.current = false; clearInterval(clock); void voice.stop().catch(() => {}); };
  }, [load, run, voice]);
  useTauriEvent("starred-sessions-changed", () => { if (!lock.current) void run(load); });
  useEffect(() => {
    if (session?.phase === "recording" && session.voiceEnabled && voiceAllowed && canRecord) {
      void voice.start(session.id,()=>current.current?.id===session.id && current.current.phase==="recording" && Date.now()<current.current.captureUntil).catch(cause => { if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not open the microphone."); });
    } else void voice.stop().catch(cause => { if (mounted.current) setError(String(cause)); });
  }, [session?.id, session?.phase, session?.voiceEnabled, voiceAllowed, canRecord, voice]);
  useEffect(() => {
    if (session?.phase !== "recording" || !canRecord) return;
    const heartbeat = setInterval(() => { if (!lock.current && !pending.current) void act("heartbeat"); }, 5000);
    return () => clearInterval(heartbeat);
  }, [session?.id, session?.phase, canRecord, act]);
  useEffect(() => {
    if (session?.phase !== "recording") return;
    const deadline = session.captureUntil;
    const timer = setTimeout(() => {
      if (stoppedAt.current !== undefined) return;
      stoppedAt.current = deadline; setNow(Date.now());
      void voice.stop(deadline).catch(cause => { if (mounted.current) setError(String(cause)); });
      void emit("focused-recording-state", null).catch(() => {});
      setError("Capture was interrupted. Your recorded work is kept. Retry to reopen its controls.");
      if (!lock.current && !pending.current) void run(load);
    }, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [session?.id, session?.phase, session?.captureUntil, load, run, voice]);
  useEffect(() => {
    if (!session || !["recording", "paused", "summary"].includes(session.phase) || name === session.name || busy || error) return;
    const timer = setTimeout(() => { if (!lock.current && !pending.current) void run(saveName); }, 400);
    return () => clearTimeout(timer);
  }, [name, session, busy, error, run, saveName]);
  useEffect(() => {
    if (!canRecord && session?.phase === "recording" && !lock.current) void act("pause");
  }, [canRecord, session?.phase, act]);
  const seconds = (session?.intervals ?? []).reduce((sum, interval) => sum + Math.max(0, (interval.end ?? Math.min(now, session!.captureUntil, stoppedAt.current ?? Infinity)) - interval.start), 0) / 1000;
  return { session, name, hot, error, busy, seconds, act, retry, toggleVoice, newWorkflow,
    setName: (value: string) => { nameRef.current = value; setNameState(value); } };
}
