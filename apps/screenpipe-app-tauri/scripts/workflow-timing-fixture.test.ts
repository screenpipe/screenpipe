// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { describe, it, expect } from "vitest";
import { timingFixture, gradeTiming } from "./workflow-timing-fixture";
const now = "2026-09-20T22:00:00Z";
const fixture = timingFixture(now, "complete");
const existing = { id: "wf-receipts", timingRuns: [], limitations: [] };
const grade = (runs: any[]) => gradeTiming([{ ...existing, timingRuns: runs }], existing, fixture.expected);
describe("timing outcome oracle", () => {
  it("accepts the two continuous runs, totaling fourteen minutes", () => {
    expect(Object.values(grade(fixture.expected)).every(Boolean)).toBe(true);
    expect(fixture.expected.map(r => (Date.parse(r.end.timestamp)-Date.parse(r.start.timestamp))/60000)).toEqual([6,8]);
  });
  it("rejects a skipped measurement and missing occurrence", () => {
    expect(grade([]).exactOccurrences).toBe(false);
    expect(grade(fixture.expected.slice(0,1)).exactOccurrences).toBe(false);
  });
  it("rejects bridging lunch, duplicate runs and invented source quotes", () => {
    expect(grade([{...fixture.expected[0],end:fixture.expected[1].end}]).exactOccurrences).toBe(false);
    expect(grade([fixture.expected[0],fixture.expected[0]]).exactOccurrences).toBe(false);
    expect(grade([{...fixture.expected[0],start:{...fixture.expected[0].start,quote:"An invented timing source"}},fixture.expected[1]]).sourceBoundaries).toBe(false);
  });
  it("preserves existing runs when no change is required", () => {
    expect(Object.values(gradeTiming([], {...existing,timingRuns:fixture.expected}, fixture.expected)).every(Boolean)).toBe(true);
  });
  it("requires explained unknown for static snapshots, never an invented hour", () => {
    const unknown = {...existing,limitations:["The captures do not establish timing boundaries."]};
    expect(Object.values(gradeTiming([],unknown,[])).every(Boolean)).toBe(true);
    expect(gradeTiming([],existing,[]).explainedUnknown).toBe(false);
    expect(gradeTiming([{...unknown,timingRuns:fixture.expected}],unknown,[]).exactOccurrences).toBe(false);
  });
});
