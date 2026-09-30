// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { useEffect, useRef, useState } from "react";
import type { WorkProfile, WorkflowScope } from "./model";
import type { WorkflowsPlatform } from "./platform";

function emptyWorkProfile(workspace: boolean): WorkProfile {
  return {
    scope: workspace ? "workspace" : "personal",
    summary: "",
    priorities: "",
    kpis: [],
    hourlyValue: null,
    vocabulary: "",
    guidance: "",
    visibility: workspace ? "aggregate-workspace" : "device-only",
  };
}

type ProfileState = { profile: WorkProfile | null; status: "loading" | "idle" | "saving" | "saved" | "error"; error: string };

export function useContextProfile(platform: WorkflowsPlatform, scope: WorkflowScope | undefined, workspace: boolean, ready: boolean) {
  const [state, setState] = useState<ProfileState>({ profile: null, status: "loading", error: "" });
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const actions = useRef({ update: (_profile: WorkProfile) => {}, retry: () => {} });

  useEffect(() => {
    if (!ready) return;
    let active = true;
    let loaded = false;
    let latest: WorkProfile | null = null;
    let pending: WorkProfile | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(timer); timer = undefined;
      if (!pending) return;
      const draft = pending; pending = null;
      // Serialize snapshots across scope changes, using the host's existing
      // persistence adapter. A late response never replaces newer edits.
      const save = writes.current.then(async () => {
        if (!platform.saveWorkProfile) throw new Error("Saving context is unavailable.");
        return platform.saveWorkProfile(draft, scope);
      });
      writes.current = save.catch(() => undefined);
      void save.then(() => {
        if (active && latest === draft) setState((current) => ({ ...current, status: "saved", error: "" }));
      }).catch(() => {
        if (active && latest === draft) setState((current) => ({ ...current, status: "error", error: "Couldn’t save your changes." }));
      });
    };
    const load = async () => {
      setState({ profile: null, status: "loading", error: "" });
      try {
        // A scope revisited immediately after an edit must see the saved draft.
        await writes.current;
        if (!active) return;
        const profile = await platform.loadWorkProfile?.(scope) ?? emptyWorkProfile(workspace);
        if (active) { loaded = true; latest = profile; setState({ profile, status: "idle", error: "" }); }
      } catch {
        if (active) setState({ profile: null, status: "error", error: "Couldn’t load your context." });
      }
    };
    actions.current = {
      update(profile) {
        if (!loaded) return;
        latest = { ...profile, updatedAt: new Date().toISOString() };
        pending = latest;
        setState({ profile: latest, status: "saving", error: "" });
        // Checkpoint continuous typing as well as individual edits and AI fields.
        timer ??= setTimeout(flush, 400);
      },
      retry() { if (!loaded) void load(); else { pending = latest; setState((current) => ({ ...current, status: "saving", error: "" })); flush(); } },
    };
    void load();
    window.addEventListener("pagehide", flush);
    window.addEventListener("blur", flush);
    return () => {
      active = false;
      flush();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("blur", flush);
    };
  }, [platform, scope?.id, scope?.kind, workspace, ready]);

  return { ...state, update: (profile: WorkProfile) => actions.current.update(profile), retry: () => actions.current.retry() };
}
