// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
export type TimingCase = "complete" | "sparse" | "preserve";
export function timingFixture(now: string, scenario: TimingCase) {
  const at = (minutes: number) => new Date(Date.parse(now) - 86400000 + minutes * 60000).toISOString();
  const row = (minute: number, quote: string, app = "Receipts") => ({ timestamp: at(minute), app, quote });
  const rows = scenario === "sparse" ? [
    row(0, "Invoice INV-123 is visible in the receipt list. No editing activity is visible."),
    row(60, "Invoice INV-123 is visible in the receipt list. No save confirmation or editing activity is visible."),
  ] : [
    row(0, "New receipt form opened for INV-123. Started entering the vendor invoice number."),
    row(2, "Editing INV-123: entered amount and selected vendor; comparing line items with its PDF."),
    row(4, "INV-123 total verified. Saving this receipt now."),
    row(6, "Receipt INV-123 saved successfully. Receipt entry complete; new blank form is closed."),
    row(25, "Lunch break. Receipt entry is not in progress.", "Calendar"),
    row(60, "New receipt form opened for INV-456. Started entering the vendor invoice number."),
    row(62, "Editing INV-456: entered amount and selected vendor; checking its invoice PDF."),
    row(64, "INV-456 line item comparison in progress; correcting the tax amount."),
    row(66, "INV-456 total verified. Saving this receipt now."),
    row(68, "Receipt INV-456 saved successfully. Receipt entry complete; new blank form is closed."),
  ];
  const source = (index: number) => ({ ...rows[index] });
  const expected = scenario === "sparse" ? [] : [
    { start: source(0), end: source(3), summary: "Enter and save receipt INV-123, with editing observed between the boundaries." },
    { start: source(5), end: source(9), summary: "Enter and save receipt INV-456, with editing observed between the boundaries." },
  ];
  return { rows, expected };
}

// Withheld fixture oracle, not production logic and never sent to the agent.
export function gradeTiming(published: any[], existing: any, expected: any[]) {
  const workflow = published.at(-1) ?? existing;
  const runs = workflow.timingRuns ?? [];
  const key = (run: any) => `${run.start?.timestamp}/${run.end?.timestamp}`;
  return {
    sameWorkflow: published.every(w => w.id === existing.id),
    exactOccurrences: runs.length === expected.length && expected.every(e => runs.some((r: any) => key(r) === key(e))),
    sourceBoundaries: runs.every((r: any) => expected.some(e => key(e) === key(r) && ["start", "end"].every(p =>
      r[p]?.app === e[p].app && typeof r[p]?.quote === "string" && r[p].quote.length >= 12 && e[p].quote.includes(r[p].quote)))),
    explainedUnknown: expected.length > 0 || [...(workflow.limitations ?? []), ...(workflow.openQuestions ?? [])].some(s => /timing|duration|boundar|elapsed/i.test(s)),
  };
}
