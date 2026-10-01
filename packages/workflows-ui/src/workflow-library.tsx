// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, BookOpen, ChevronRight, Search, Sparkles } from "lucide-react";
import { guideKey, type WorkflowGuide as Guide } from "./guide";
import type { WorkflowMap, WorkflowSkillDraft } from "./model";
import type { WorkflowsPlatform } from "./platform";
import { WorkflowGuide } from "./workflow-guide";
import styles from "./workflow-library.module.css";

type Draft = { workflowKey: string; draft: WorkflowSkillDraft };
type Installed = { name: string; description: string; path: string };
const message = (error: unknown) => error instanceof Error ? error.message : "Could not load your library. Try again.";

// A removed source must not make its saved document inaccessible or invent evidence.
export function detachedGuideWorkflow(guide: Guide): WorkflowMap {
  return {
    id: guide.workflowKey, revision: guide.sourceRevision, title: guide.title,
    description: guide.summary, rank: 0, analysisDays: 0, repetitions: 0, frequency: "",
    trigger: "", outcome: "", totalMinutes: 0, activeMinutes: 0, waitingMinutes: 0,
    appSwitches: 0, confidence: 0, apps: [], handoffs: [], variations: [], stages: [],
    bottlenecks: [], evidence: [], quality: { grade: "limited", evidenceCount: 0,
      distinctDays: 0, stageEvidenceCoverage: 0, repeatedStageCoverage: 0,
      screenshotCount: 0, stageScreenshotCoverage: 0, reasons: [] },
  };
}

export function WorkflowLibrary({ platform, workflows }: { platform: WorkflowsPlatform; workflows: WorkflowMap[] }) {
  const [tab, setTab] = useState<"sops" | "skills">(() => new URLSearchParams(window.location.search).get("libraryTab") === "skills" ? "skills" : "sops");
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(window.location.search).get("libraryItem"));
  const [guides, setGuides] = useState<Guide[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [installedError, setInstalledError] = useState("");
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const refresh = () => setRevision(value => value + 1);
  function route(nextTab: typeof tab, item: string | null) {
    setTab(nextTab); setSelected(item); setQuery("");
    const url = new URL(window.location.href);
    url.searchParams.set("view", "library"); url.searchParams.set("libraryTab", nextTab);
    if (item) url.searchParams.set("libraryItem", item); else url.searchParams.delete("libraryItem");
    window.history.pushState(null, "", url);
  }
  useEffect(() => {
    const sync = () => {
      const params = new URLSearchParams(window.location.search);
      setTab(params.get("libraryTab") === "skills" ? "skills" : "sops");
      setSelected(params.get("libraryItem"));
      refresh();
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setInstalledError("");
    const load = tab === "sops"
      ? (platform.guides?.list?.() ?? Promise.resolve([])).then(value => { if (!cancelled) setGuides(value); })
      : (platform.library?.listSkillDrafts() ?? Promise.resolve([])).then(value => { if (!cancelled) setDrafts(value); });
    void load.catch(cause => { if (!cancelled) setError(message(cause)); }).finally(() => { if (!cancelled) setLoading(false); });
    if (tab === "skills" && platform.library?.listInstalledSkills) {
      void platform.library.listInstalledSkills().then(value => { if (!cancelled) setInstalled(value); }).catch(() => { if (!cancelled) setInstalledError("Could not check installed skills. Your saved drafts are still available."); });
    }
    return () => { cancelled = true; };
  }, [platform, tab, revision]);
  const close = () => { route(tab, null); refresh(); };
  const guide = guides.find(item => item.workflowKey === selected);
  const source = guide && workflows.find(workflow => guideKey(workflow) === guide.workflowKey);
  if (tab === "sops" && guide && platform.guides) {
    // Load by the saved key, including when the source is no longer in the catalog.
    const adapter = source ? platform.guides : { ...platform.guides, edit: undefined, video: undefined };
    return <><WorkflowGuide key={guide.workflowKey} workflow={source ?? detachedGuideWorkflow(guide)} platform={adapter} sourceMissing={!source} close={close} backLabel="Back to Library" /></>;
  }
  const draft = drafts.find(item => item.workflowKey === selected);
  if (tab === "skills" && draft && platform.library) return <LibrarySkill key={draft.workflowKey} entry={draft} platform={platform} close={close} />;
  const filter = (title: string, summary: string) => `${title} ${summary}`.toLowerCase().includes(query.toLowerCase());
  const visibleGuides = guides.filter(g => filter(g.title, g.summary));
  const visibleDrafts = drafts.filter(d => filter(d.draft.name, d.draft.description));
  const visibleInstalled = installed.filter(skill => !drafts.some(d => d.draft.name === skill.name) && filter(skill.name, skill.description));
  const count = tab === "sops" ? visibleGuides.length : visibleDrafts.length + visibleInstalled.length;
  return <section className={styles.library}>
    <h1>Library</h1><p className={styles.subtitle}>Your saved SOPs and skills.</p>
    <div className={styles.controls}><div className={styles.tabs} aria-label="Library sections">{(["sops", "skills"] as const).map(value => <button key={value} aria-pressed={tab === value} onClick={() => route(value, null)}>{value === "sops" ? "SOPs" : "Skills"}</button>)}</div>
      <label className={styles.search}><Search size={16} /><input aria-label="Search library" placeholder={tab === "sops" ? "Search SOPs" : "Search skills"} value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    {error && <p role="alert">{error} <button onClick={refresh}>Try again</button></p>}
    {installedError && tab === "skills" && <p role="alert">{installedError} <button onClick={refresh}>Try again</button></p>}
    {loading ? <p role="status">Loading your library…</p> : !error && <>
      {selected && <p role="status">This item could not be found in the saved library.</p>}
      {!count && <div className={styles.empty}>{tab === "sops" ? <BookOpen size={24} /> : <Sparkles size={24} />}<h2>{query ? "No matching items" : tab === "sops" ? "No saved SOPs yet" : "No saved skills yet"}</h2><p>{query ? "Try another search." : `Open a workflow and choose ${tab === "sops" ? "Create SOP" : "Create skill"}. It will be saved here.`}</p></div>}
      <div className={styles.items}>{tab === "sops" ? visibleGuides.map(g => <button className={styles.row} key={g.workflowKey} onClick={() => route("sops", g.workflowKey)}><BookOpen size={19} /><span><strong>{g.title}</strong><small>{g.steps.length} steps</small></span><ChevronRight size={17} /></button>) : <>
        {visibleDrafts.map(d => <button className={styles.row} key={d.workflowKey} onClick={() => route("skills", d.workflowKey)}><Sparkles size={19} /><span><strong>{d.draft.name || "Untitled skill"}</strong><small>{d.draft.description}</small></span><ChevronRight size={17} /></button>)}
        {visibleInstalled.map(s => <details className={styles.installed} key={s.path}><summary><Sparkles size={19} /><span><strong>{s.name}</strong><small>{s.description}</small></span><small>Installed</small></summary><p>Available to Screenpipe on this device.</p><code>{s.path}</code></details>)}
      </>}</div>
    </>}
  </section>;
}

function LibrarySkill({ entry, platform, close }: { entry: Draft; platform: WorkflowsPlatform; close: () => void }) {
  const [draft, setDraft] = useState(entry.draft);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const writeVersion = useRef(0);
  async function save(install = false) {
    setBusy(true); setStatus("");
    try {
      await platform.library!.saveSkillDraft(entry.workflowKey, draft); setDirty(false);
      if (install && platform.saveWorkflowSkill) {
        const receipt = await platform.saveWorkflowSkill(draft);
        setStatus([...receipt.destinations.map(d => `Installed in ${d}.`), ...receipt.warnings].join(" ") || "No installation completed.");
      } else setStatus("Saved in Library");
    } catch (cause) { setStatus(message(cause)); }
    finally { setBusy(false); }
  }
  function change(next: WorkflowSkillDraft) {
    setDraft(next); setDirty(true); setStatus("Saving…");
    const version = ++writeVersion.current;
    void platform.library!.saveSkillDraft(entry.workflowKey, next).then(() => {
      if (version === writeVersion.current) { setDirty(false); setStatus("Saved in Library"); }
    }).catch(cause => { if (version === writeVersion.current) setStatus(message(cause)); });
  }
  return <section className={styles.library}>
    <button className={styles.back} disabled={busy} onClick={close}><ArrowLeft size={16} />Back to Library</button>
    <h1>{draft.name || "Untitled skill"}</h1>
    <div className={styles.editor}>
      <label>Name<input value={draft.name} maxLength={64} onChange={e => change({ ...draft, name: e.target.value })} /></label>
      <label>When to use<textarea value={draft.description} maxLength={500} onChange={e => change({ ...draft, description: e.target.value })} /></label>
      <label>Instructions<textarea className={styles.instructions} value={draft.instructions} maxLength={20000} onChange={e => change({ ...draft, instructions: e.target.value })} /></label>
    </div>
    <div className={styles.actions}><button disabled={busy || !dirty} onClick={() => void save()}>Save changes</button>{platform.saveWorkflowSkill && <button disabled={busy || !draft.name.trim() || !draft.instructions.trim() || !draft.description.trim()} onClick={() => void save(true)}>{platform.skillInstallMode === "preview" ? "Preview installation" : "Install in my agents"}</button>}<span role="status">{busy ? "Saving…" : status}</span></div>
  </section>;
}
