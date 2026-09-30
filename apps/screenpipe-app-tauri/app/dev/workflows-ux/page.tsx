// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useState } from "react";
import { WorkflowsApp, type WorkflowAnalysis, type WorkflowRunActivity, type WorkflowSkillDraft } from "@screenpipe/workflows-ui";
import { createFixtureWorkflowsPlatform, fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";
import { FirstTaskChoice } from "@/components/workflows/first-task-choice";
import { WorkflowAccessNotice } from "@/components/workflows/workflow-access";
import { fixtureWorkflowTasks } from "@/lib/dev/workflow-tasks-fixture";
import { WorkflowTasksPrompt } from "@/components/workflows/workflow-tasks-prompt";
import { ProductSwitcher } from "@/components/workflows/product-switcher";
import { useGT } from "gt-react";


const fixture = createFixtureWorkflowsPlatform();
// Older saved workflows have image bytes but no visual-verification metadata.
const legacyAnalysis = structuredClone(fixtureWorkflowAnalysis);
for (const workflow of legacyAnalysis.analysis.workflows) {
  for (const stage of workflow.stages) {
    if (stage.screenshot) delete stage.screenshot.visualVerified;
  }
}
const legacyFixture = createFixtureWorkflowsPlatform(legacyAnalysis);
const unchangedAnalysis: WorkflowAnalysis = { ...fixtureWorkflowAnalysis,
  analyzedAt: "2026-09-17T17:55:00Z", checkedThrough: "2026-09-16T21:08:00Z", changes: {created:0,updated:0} };
const unchangedFixture = { ...createFixtureWorkflowsPlatform(unchangedAnalysis), managesAnalysis:true,
  getLatestAnalysisJob: async () => ({id:"unchanged-preview",status:"complete" as const,result:unchangedAnalysis}) };

// Fictional receipt for the installed-state design only; no filesystem calls.
const installedSkillFixture = { ...fixture, skillInstallMode: "local" as const,
  saveWorkflowSkill: async (draft: WorkflowSkillDraft) => ({ name: draft.name, path: `/example/skills/${draft.name}/SKILL.md`, updated: false,
    destinations: ["Screenpipe", "Claude Code", "Codex", "Hermes"],
    locations: ["Screenpipe", "Claude Code", "Codex", "Hermes"].map(destination => ({ destination, path: `/example/${destination}/skills/${draft.name}/SKILL.md` })), warnings: [] }),
};
let previewRun = { id: "preview", status: "processing" as "processing" | "failed", startedAt: new Date().toISOString(), message: "Update stopped. Your saved workflows are still available." };
const processingFixture = { ...fixture, managesAnalysis: true,
  getLatestAnalysisJob: async () => previewRun,
  getAnalysisJob: async () => previewRun,
  cancelAnalysisJob: async () => { previewRun = { ...previewRun, status: "failed" }; },
  startAnalysisJob: async () => { previewRun = { ...previewRun, id: String(Date.now()), status: "processing", startedAt: new Date().toISOString() }; return previewRun; },
  subscribeAnalysisActivity: async (_id: string, onActivity: (items: WorkflowRunActivity[]) => void) => {
    // Fictional tool summaries exercise the same UI subscription contract.
    onActivity([{ id: "1", label: "Read work context", status: "complete" },
      { id: "2", label: "Searched captured activity", status: "complete" },
      { id: "3", label: "Inspecting captured moments", status: "running" }]);
    return () => {};
  },
};
// Maintained browser-mock harness: real product components, synthetic history.
// This route never enables fixtures in a packaged application.
export default function WorkflowUxPreview() {

  const ui = useGT();
  const [accessRequested, setAccessRequested] = useState(false);
  const [screen, setScreen] = useState<"onboarding" | "empty" | "catalog" | "processing" | "tasks" | "skill" | "allowance" | "business" | "legacy" | "no-changes">("processing");
  if (process.env.NEXT_PUBLIC_SCREENPIPE_WEB_DEV !== "mock") return null;
  return <div className="h-screen bg-background text-foreground">
    <nav aria-label={ui("Preview states")} className="flex h-10 items-center justify-between gap-4 border-b border-border px-4 text-xs">
      <span className="text-muted-foreground">UX preview · fictional data</span>
      <div className="flex gap-4"><button onClick={() => setScreen("no-changes")}>No changes</button><button onClick={() => setScreen("legacy")}>SOP screenshots</button><button onClick={() => setScreen("allowance")}>Low allowance</button><button onClick={() => setScreen("business")}>Business access</button><button onClick={() => setScreen("skill")}>Skill install result</button><button onClick={() => setScreen("tasks")}>Enable tasks</button><button onClick={() => setScreen("onboarding")}>First task</button><button onClick={() => setScreen("empty")}>New history</button><button onClick={() => setScreen("catalog")}>Existing history</button><button onClick={() => setScreen("processing")}>Processing preview</button></div>
    </nav>
    <div style={{height:"calc(100vh - 40px)", overflow:"auto"}}>
      {screen === "onboarding" ? <div className="flex min-h-full items-center"><FirstTaskChoice onComplete={async (mode) => { if(mode === "screenpipe") window.location.assign("/home?mode=screenpipe"); else setScreen("empty"); }} /></div>
        : <WorkflowsApp toolbarAccessory={screen === "tasks" ? <WorkflowTasksPrompt active tasks={fixtureWorkflowTasks} /> : undefined} onAnalysisUnavailable={() => setAccessRequested(true)} analysisUnavailableReason={screen === "allowance" || screen === "business" ? "Workflow updates are paused" : undefined} key={screen} statusNotice={screen === "allowance" || screen === "business" ? <WorkflowAccessNotice open={accessRequested} onOpenChange={setAccessRequested} access={screen === "allowance" ? {state:"paused",resetAt:undefined,message:"Workflow updates are paused to preserve AI allowance for chat."} : {state:"upgrade",message:"Automatic workflow discovery is included with Business. Your saved workflows remain available."}} onRetry={() => {}} onAccount={() => {}} onUsage={() => {}} /> : undefined} platform={screen === "no-changes" ? unchangedFixture : screen === "legacy" ? legacyFixture : screen === "processing" ? processingFixture : screen === "skill" ? installedSkillFixture : fixture} storageKey={null} initialAnalysis={screen === "no-changes" ? unchangedAnalysis : screen === "legacy" ? legacyAnalysis : (screen === "catalog" || screen === "tasks" || screen === "skill" || screen === "processing" || screen === "allowance" || screen === "business") ? fixtureWorkflowAnalysis : null} navigationBrand={<ProductSwitcher mode="workflows" onChange={mode => {if(mode === "screenpipe") window.location.assign("/home?mode=screenpipe");}} />} />}
    </div>
  </div>;
}
