// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import type { WorkflowMap } from "@screenpipe/workflows-ui";
import type { CloudWorkflow } from "./cloud-catalog";

/** Map only supplied cloud fields. Missing recordings, timing and observations
 * stay unknown; the read-only view does not imply they were measured locally. */
export function cloudWorkflowMap(workflow: CloudWorkflow, index: number): WorkflowMap {
  const apps = [...new Set(workflow.steps.flatMap(step => step.app ? [step.app] : []))];
  return {
    id: workflow.id, revision: workflow.version, rank: index + 1, analysisDays: 0,
    title: workflow.title, description: workflow.summary, trigger: workflow.trigger ?? "Not documented",
    outcome: workflow.outcome ?? "Not documented", frequency: workflow.frequency ?? "",
    repetitions: 0, totalMinutes: 0, activeMinutes: 0, waitingMinutes: 0, durationSource: "unknown",
    confidence: 0, appSwitches: 0, apps, handoffs: [], variations: [], bottlenecks: [], evidence: [],
    quality: { grade: "limited", evidenceCount: 0, distinctDays: 0, stageEvidenceCoverage: 0,
      repeatedStageCoverage: 0, screenshotCount: 0, stageScreenshotCoverage: 0, reasons: [] },
    stages: workflow.steps.map(step => ({ name: step.action, description: step.detail ?? "",
      activeMinutes: 0, waitingMinutes: 0, durationSource: "unknown", confidence: 0,
      observedOccurrences: 0, observedDays: 0, evidence: [], apps: step.app ? [step.app] : [],
      procedure: [{ kind: "action", text: step.detail || step.action, app: step.app ?? "", quote: "", timestamp: "" },
        ...(step.expected_result ? [{ kind: "check" as const, text: step.expected_result, app: step.app ?? "", quote: "", timestamp: "" }] : [])],
    })),
  };
}
