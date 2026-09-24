// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import type { WorkflowTaskSetup } from "@/lib/workflows/scheduled-discovery";

const key = "screenpipe-web-workflow-schedules";
function read(): boolean[] {
  const saved = JSON.parse(localStorage.getItem(key) || "null");
  return Array.isArray(saved) && saved.length === 4 && saved.every(value => typeof value === "boolean") ? saved : [true, true, true, true];
}
// Browser-mock only. These settings never touch the recorder or run agents.
function scenario() { return new URLSearchParams(window.location.search).get("workflowScheduleState"); }
let failedOnce = false;
export const fixtureWorkflowTasks = {
  async load(): Promise<WorkflowTaskSetup> {
    if (scenario() === "unavailable") throw new Error("Fixture disconnected");
    const states = read();
    return {enabled: states.every(Boolean), title: "Keep your workflows current", schedule: "Hourly discovery, with evidence review and maintenance",
      tasks: ["Discover", "Deepen", "Review", "Maintain"].map((title, i) => ({name: title, title, enabled: states[i]}))};
  },
  async enable() { localStorage.setItem(key, JSON.stringify([true, true, true, true])); },
  async disable() {
    if (scenario() === "saving") await new Promise(resolve => setTimeout(resolve, 2500));
    if (scenario() === "failure" && !failedOnce) {
      failedOnce = true;
      localStorage.setItem(key, JSON.stringify([false, true, true, true]));
      throw new Error("Fixture partial failure");
    }
    localStorage.setItem(key, JSON.stringify([false, false, false, false]));
  },
};
