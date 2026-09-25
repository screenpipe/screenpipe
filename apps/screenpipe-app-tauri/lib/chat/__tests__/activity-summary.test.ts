// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { describe, expect, it } from "vitest";
import { summarizeToolActivities, toolActivityFileName } from "../tool-presentation";
describe("completed activity summaries", () => {
  it("describes mixed work and keeps parent paths and raw commands out of the summary", () => {
    const summary = summarizeToolActivities([
      { toolName: "query_recordings", args: { q: "handoff" } },
      { toolName: "read", args: { path: "/private/work/checklist.md" } },
      { toolName: "edit", args: { path: "/private/work/checklist.md" } },
    ]);
    expect(summary).toBe("Searched recordings · Read checklist.md · Updated checklist.md");
    expect(summary).not.toContain("/private");
  });
  it("counts distinct paths and repeated queries without dropping any activity", () => {
    expect(summarizeToolActivities([
      { toolName: "read", args: { path: "/a/notes.md" } },
      { toolName: "read", args: { path: "/b/notes.md" } },
      { toolName: "read", args: { path: "/a/notes.md" } },
      { toolName: "query_recordings" }, { toolName: "query_recordings" },
    ])).toBe("Read 2 files · Searched recordings ×2");
    expect(toolActivityFileName({ toolName: "read", args: { filePath: "C:\\work\\notes.md" } })).toBe("notes.md");
  });
  it("never describes failed or running writes as completed", () => {
    const failure = { toolName: "edit", args: { path: "/a/notes.md" }, isError: true };
    expect(summarizeToolActivities([failure])).toBe("Activity failed");
    expect(summarizeToolActivities([{ ...failure, isError: false, isRunning: true }])).toBe("Working");
    expect(summarizeToolActivities([{ toolName: "read", args: { path: "README.md" } }, failure])).toBe("Read README.md");
  });
});
