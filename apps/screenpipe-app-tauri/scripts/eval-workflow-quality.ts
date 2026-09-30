// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Audit an isolated pipeline report. Raw activity and reports must stay private.
import {readFile, writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {sourceEvidence, matchesEvidence, type Evidence} from './eval-workflow-evidence';
const directory = process.argv[2];
if (!directory) throw new Error('Usage: bun scripts/eval-workflow-quality.ts PRIVATE_REPORT_DIR');
const report = JSON.parse(await readFile(join(directory,'result.json'),'utf8'));
const seed = await Bun.file(join(directory,'context.json')).exists() ? await Bun.file(join(directory,'context.json')).json() : null;
const sources: Evidence[] = [];
for (const read of report.reads || []) {
  sources.push(...sourceEvidence(read, await readFile(join(directory,read.file),'utf8')));
}
const grounded = (claim:any) => matchesEvidence(claim, sources);
const workflows = report.catalog?.workflows || [];
const issues: string[] = [];
let steps = 0, supported = 0, retained = 0, runs = 0;
const markdown = ['# Workflow quality review', '', `Window: ${report.window.start} to ${report.window.end}`, '', 'These are generated proposals from an isolated catalog. Exact source matches verify grounding, not whether the quoted text proves the action. Review the meaning of each claim before using it.', ''];
for (const [index,workflow] of workflows.entries()) {
  const prior = seed?.workflows?.find((w:any)=>w.id && w.id===workflow.id);
  const priorSteps = prior?.stages?.flatMap((s:any)=>s.procedure || []) || [];
  if (!workflow.trigger?.trim() || !workflow.outcome?.trim() || !(workflow.stages || []).some((stage:any)=>stage.procedure?.length)) issues.push(`${workflow.title}: missing usable trigger, outcome or steps`);
  markdown.push(`## ${index+1}. ${workflow.title}`, '', `**Trigger:** ${workflow.trigger}`, '', `**Outcome:** ${workflow.outcome}`, '', workflow.description || '', '');
  for (const stage of workflow.stages || []) {
    markdown.push(`### ${stage.name}`, '');
    for (const step of stage.procedure || []) {
      steps++;
      const matched = grounded(step);
      const unchanged = priorSteps.some((p:any)=>["kind","text","timestamp","app","quote"].every(key=>p[key]===step[key]));
      if (matched) supported++; else if (unchanged) retained++; else issues.push(`${workflow.title}: unmatched source for ${step.text}`);
      markdown.push(`- **${step.kind}:** ${step.text}`, `  - Source ${matched ? 'matched' : unchanged ? 'retained from prior catalog, not reverified' : 'NOT MATCHED'}: ${step.timestamp}, ${step.app}`, `  - Quote: ${JSON.stringify(step.quote)}`);
    }
    markdown.push('');
  }
  for (const run of workflow.timingRuns || []) {
    runs++;
    const unchanged = prior?.timingRuns?.some((r:any)=>JSON.stringify(r)===JSON.stringify(run));
    if (!unchanged && (!grounded(run.start) || !grounded(run.end) || Date.parse(run.end.timestamp)<=Date.parse(run.start.timestamp))) issues.push(`${workflow.title}: invalid or unsupported timing`);
  }
  markdown.push(`Timing: ${(workflow.timingRuns || []).length} proposed measured occurrences.`, '', `Open questions: ${(workflow.openQuestions || []).join('; ') || 'None supplied'}`, '', `Limitations: ${(workflow.limitations || []).join('; ') || 'None supplied'}`, '');
}
if (!workflows.length) issues.push('No workflows generated; inspect retrieval and stage outputs before judging quality.');
const score = {workflows:workflows.length,steps,supportedSteps:supported,retainedUnverifiedSteps:retained,timingRuns:runs,issues,semanticReviewRequired:true};
await writeFile(join(directory,'quality.json'),JSON.stringify(score,null,2),{mode:0o600});
await writeFile(join(directory,'review.md'),markdown.join('\n'),{mode:0o600});
console.log(JSON.stringify({...score,report:resolve(directory,'review.md')}));
process.exitCode = issues.length ? 1 : 0;
