// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Check, ChevronDown, Loader2, LockKeyhole, Pause, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/lib/hooks/use-settings";
import { localFetch } from "@/lib/api";
import { SCREENPIPE_STARTER_SKILLS } from "@/lib/generated/screenpipe-skills";
import { useGT } from "gt-react";


const SLUG = "skill-learning";
type State = "checking" | "missing" | "paused" | "enabled" | "error";

async function request(path: string, body?: unknown) {
  const response = await localFetch(path, {
    ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json();
  if (path === `/pipes/${SLUG}` && (response.status === 404 || typeof data.error === "string" && data.error.includes("not found"))) return null;
  if (!response.ok || data.error || data.success === false) throw new Error("Could not reach Screenpipe. Retry when it is ready.");
  return data;
}

export function StarterSkillsCard() {

  const ui = useGT();
  const { settings } = useSettings();
  // ACP/cloud-agent executors do not load the restricted Pi extension.
  const presets = (settings.aiPresets ?? []).filter(p => p.provider !== "acp" && !!p.model);
  const [preset, setPreset] = useState("");
  const [state, setState] = useState<State>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [schedule, setSchedule] = useState("every 6h");
  const [savedModel, setSavedModel] = useState("");
  const [query, setQuery] = useState("");
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [lastSuccess, setLastSuccess] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  function readActivity(data: { last_run?: string; last_success?: boolean; is_running?: boolean }) {
    setLastRun(data.last_run ?? null);
    setLastSuccess(data.last_success ?? null);
    setRunning(data.is_running === true);
  }
  const operation = useRef(false);
  const selected = presets.find(p => p.id === preset);
  const defaultPreset = presets.find(p => p.defaultPreset) ?? presets[0];
  const effectivePreset = selected ?? (!preset ? defaultPreset : undefined);

  const refresh = useCallback(async () => {
    try {
      const data = await request(`/pipes/${SLUG}`);
      if (data === null) { readActivity({}); setState("missing"); return; }
      const config = data?.data?.config;
      if (typeof config?.enabled !== "boolean") throw new Error("Could not check the learning task. Retry when Screenpipe is ready.");
      readActivity(data.data);
      setState(config.enabled ? "enabled" : "paused");
      const configured = Array.isArray(config.preset) ? config.preset[0] : config.preset;
      if (configured) setPreset(configured);
      setSavedModel(config.model ?? "");
      setSchedule(config.schedule ?? "every 6h");
    } catch (e) { setState("error"); setError(e instanceof Error ? e.message : ui("Could not check the learning task.")); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function changeModel(id: string) {
    if (operation.current || !presets.some(p => p.id === id) || id === effectivePreset?.id) return;
    operation.current = true; setBusy(true); setError("");
    try {
      const current = await request(`/pipes/${SLUG}`);
      // Choosing a model before setup must not install or enable the task.
      if (current === null) { setPreset(id); setState("missing"); return; }
      await request(`/pipes/${SLUG}/config`, { agent: "pi", preset: [id], cloud_agent: null });
      const verified = await request(`/pipes/${SLUG}`);
      const config = verified?.data?.config;
      const configured = Array.isArray(config?.preset) ? config.preset[0] : config?.preset;
      if (configured !== id || typeof config?.enabled !== "boolean") {
        throw new Error("Could not verify the model change. Check the task before retrying.");
      }
      readActivity(verified.data);
      setPreset(id);
      setSavedModel(config.model ?? "");
      setState(config.enabled ? "enabled" : "paused");
    } catch (e) { setError(e instanceof Error ? e.message : ui("Could not save the model. Please retry.")); }
    finally { operation.current = false; setBusy(false); }
  }

  async function changeEnabled(enabled: boolean) {
    if (operation.current || enabled && !effectivePreset) return;
    operation.current = true; setBusy(true); setError("");
    try {
      // Re-read before mutation; a remount or another window may have changed it.
      const current = await request(`/pipes/${SLUG}`);
      if (current === null && enabled) await request(`/pipes/bundled/${SLUG}/install`, {});
      if (enabled) {
        await request(`/pipes/${SLUG}/config`, { agent: "pi", preset: [effectivePreset!.id], cloud_agent: null });
      }
      await request(`/pipes/${SLUG}/enable`, { enabled });
      const verified = await request(`/pipes/${SLUG}`);
      if (verified?.data?.config?.enabled !== enabled) throw new Error("The change could not be verified. Check the task before retrying.");
      readActivity(verified.data);
      setState(enabled ? "enabled" : "paused");
      if (enabled) setPreset(effectivePreset!.id);
    } catch (e) { setError(e instanceof Error ? e.message : ui("Setup failed. Please retry.")); }
    finally { operation.current = false; setBusy(false); }
  }

  const enabled = state === "enabled";
  const label = state === "checking" ? ui("Checking…") : state === "error" ? ui("Status unavailable") : enabled ? ui("On") : ui("Off");
  const cadence = schedule === "every 6h" ? ui("Every 6 hours") : schedule;
  const filteredSkills = SCREENPIPE_STARTER_SKILLS.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const runDate = lastRun ? new Date(lastRun) : null;
  const validRunDate = runDate && !Number.isNaN(runDate.getTime()) ? runDate : null;
  const refreshStatus = () => { if (!operation.current) { setError(""); setState("checking"); void refresh(); } };
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-background" aria-label={ui("Screenpipe starter skills")} data-testid="starter-skills-card">
      <div className="p-4">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h3 className="text-sm font-medium">Included skills</h3>
          <span className="ml-auto rounded-sm border border-border px-2 py-0.5 text-xs text-muted-foreground">{SCREENPIPE_STARTER_SKILLS.length} included</span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Ready-made workflows for recall, meetings, research, and follow-ups. Added to supported agents during setup and kept current with app updates.</p>
        <details className="group mt-3">
          <summary className="flex cursor-pointer list-none items-center justify-between rounded-md border border-border px-3 py-2.5 text-xs font-medium hover:bg-muted/50 focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground focus-visible:outline-offset-2">
            Browse included skills <ChevronDown className="h-4 w-4 group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="mt-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <input type="search" aria-label={ui("Search included skills")} placeholder={ui("Search by task or skill")} value={query} onChange={e => setQuery(e.target.value)} className="h-10 w-full rounded-md border border-border bg-background pl-9 pr-3 text-xs focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground focus-visible:outline-offset-2" />
            </div>
            <p className="my-2 text-xs text-muted-foreground" role="status">{filteredSkills.length} of {SCREENPIPE_STARTER_SKILLS.length} skills</p>
            <ul className="grid max-h-72 gap-x-5 overflow-y-auto sm:grid-cols-2" aria-label={ui("Included skills")}>
              {filteredSkills.map(skill => {
                const name = skill.name.replace("screenpipe-", "").replaceAll("-", " ");
                return <li key={skill.name} className="border-t border-border py-3">
                  <p className="text-xs font-medium">{name.charAt(0).toUpperCase() + name.slice(1)}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{skill.description}</p>
                </li>;
              })}
            </ul>
            {filteredSkills.length === 0 && <p className="py-4 text-xs text-muted-foreground">No matching skills. Try a task like meetings or research.</p>}
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Claude Code, Codex, Cursor, Gemini CLI, OpenClaw, and Hermes. Other MCP clients can read the bundled skills through Screenpipe. Your edits and personal skills are preserved.</p>
          </div>
        </details>
      </div>
      <div className="border-t border-border p-4">
        <div className="flex items-center gap-2">
          <LockKeyhole className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h3 className="text-sm font-medium">Learn from my work</h3>
          <span className="ml-auto rounded-sm border border-border px-2 py-0.5 text-xs text-muted-foreground" role="status">{label}</span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Find repeated patterns in recent work and AI chat previews. Improve an existing skill or create one when it adds something useful.</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{cadence}</span><span aria-hidden="true">·</span><span>At most one change per run</span>
        </div>
        <div className="mt-4 flex flex-col items-stretch gap-3 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1 text-xs font-medium">Model
            <select aria-label={ui("Skill learning model")} aria-busy={busy} className="mt-1.5 block h-10 w-full rounded-md border border-border bg-background px-3 text-xs font-normal text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground focus-visible:outline-offset-2" value={effectivePreset?.id ?? ""} onChange={e => void changeModel(e.target.value)} disabled={busy || state === "checking" || state === "error"}>
              {!effectivePreset && <option value="">Choose a model in Settings</option>}
              {presets.map(p => <option key={p.id} value={p.id}>{p.model} · {p.provider}</option>)}
            </select>
          </label>
          {state === "error" ? <Button className="h-10" size="sm" variant="outline" onClick={refreshStatus}><RefreshCw className="mr-2 h-3 w-3" />Retry</Button> :
            <Button className="h-10" size="sm" variant={enabled ? "outline" : "default"} disabled={busy || state === "checking" || !enabled && !effectivePreset} onClick={() => void changeEnabled(!enabled)} aria-busy={busy}>
              {busy ? <Loader2 className="mr-2 h-3 w-3 animate-spin motion-reduce:animate-none" /> : enabled ? <Pause className="mr-2 h-3 w-3" /> : <Check className="mr-2 h-3 w-3" />}
              {busy ? ui("Saving…") : enabled ? ui("Pause learning") : ui("Turn on learning")}
            </Button>}
        </div>
        <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>{effectivePreset ? ui("Model changes apply to future runs.") : ui("Add a compatible model to turn on learning.")}</span>
          <a className="text-foreground underline underline-offset-4" href="/settings?section=ai">Manage models</a>
        </div>
        <div className="mt-4 rounded-md bg-muted/40 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">Learned skills stay in Screenpipe</p>
          <p className="mt-1">{effectivePreset?.provider === "native-ollama" ? ui("Uses your local model.") : ui("Context is sent to the selected model provider{value1}.", { value1: enabled && !effectivePreset && savedModel ? ` (${savedModel})` : "" })} Learned skills are not automatically shared with other agents.</p>
        </div>
        {state !== "checking" && state !== "error" && <div className="mt-3 flex items-start justify-between gap-3 text-xs text-muted-foreground">
          <div>
            <p>{running ? ui("Run in progress") : validRunDate ? <>{lastSuccess === false ? ui("Last run failed") : ui("Last run")} · <time dateTime={lastRun!}>{validRunDate.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></> : ui("No run recorded yet")}</p>
            {enabled && <p className="mt-1">Pause stops future runs; a current run may finish.</p>}
            {!enabled && running && <p className="mt-1">Future runs are paused. The current run may finish.</p>}
          </div>
          <button type="button" aria-label={ui("Refresh learning status")} className="shrink-0 rounded-md p-1.5 hover:bg-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground" onClick={refreshStatus} disabled={busy}><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /></button>
        </div>}
        <a className="mt-3 inline-block text-xs text-foreground underline underline-offset-4" href="/home?section=pipes&tab=my-pipes">Review learning in scheduled tasks</a>
        {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
      </div>
    </section>
  );
}
