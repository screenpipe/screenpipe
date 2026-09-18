// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('quality audit accepts literal CSV/audio evidence and rejects invented quotes and empty procedures',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workflow-quality-audit-'));
  try {
    await writeFile(join(dir,'source.csv'),'content.timestamp,content.app_name,content.text\n2026-01-01T10:00:00Z,Receipts,"Saved receipt,\nchecked total"\n');
    await writeFile(join(dir,'audio.json'),JSON.stringify({data:[{type:'Audio',content:{timestamp:'2026-01-01T10:01:00Z',transcription:'I need to check the receipt.'}}]}));
    const step={kind:'action',text:'Save receipt',timestamp:'2026-01-01T10:00:00Z',app:'Receipts',quote:'Saved receipt,\nchecked total'};
    const report={window:{start:'2026-01-01T10:00:00Z',end:'2026-01-01T11:00:00Z'},reads:[{status:200,contentType:'text/csv',file:'source.csv'},{status:200,contentType:'application/json',file:'audio.json'}],catalog:{workflows:[{title:'Store receipt',trigger:'Receipt arrives',outcome:'Receipt stored',stages:[{name:'Save',procedure:[step,{...step,timestamp:'2026-01-01T10:01:00Z',app:'Conversation',quote:'I need to check the receipt.'}]}],timingRuns:[]}]}};
    const run=async()=>{
      await writeFile(join(dir,'result.json'),JSON.stringify(report));
      const child=Bun.spawn([process.execPath,join(import.meta.dir,'eval-workflow-quality.ts'),dir],{stdout:'pipe',stderr:'pipe'});
      const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      if(stderr) throw new Error(stderr);
      return {exit,value:JSON.parse(stdout)};
    };
    const valid=await run();expect(valid.exit).toBe(0);expect(valid.value.supportedSteps).toBe(2);
    step.quote='Saved ... checked total';
    const invalid=await run(); expect(invalid.exit).toBe(1);expect(invalid.value.supportedSteps).toBe(1);
    report.catalog.workflows[0].stages[0].procedure=[];
    expect((await run()).exit).toBe(1);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('evidence checks distinguish source text, timestamp, app and failed reads', async () => {
  const { sourceEvidence, matchesEvidence } = await import('./eval-workflow-evidence');
  const response = JSON.stringify({ data: [{ type: 'UI', 'content.timestamp': '2026-01-01T10:00:00Z', 'content.text': 'Receipt saved' }] });
  const read = { status: 200, contentType: 'application/json', path: '/search?app_name=Receipts' };
  const sources = sourceEvidence(read, response);
  const claim = { timestamp: '2026-01-01T02:00:00-08:00', app: 'Receipts', quote: 'Receipt saved' };
  expect(matchesEvidence(claim, sources)).toBe(true);
  expect(matchesEvidence({ ...claim, timestamp: '2026-01-01T10:01:00Z' }, sources)).toBe(false);
  expect(matchesEvidence({ ...claim, app: 'Mail' }, sources)).toBe(false);
  expect(matchesEvidence({ ...claim, quote: 'Receipt sent' }, sources)).toBe(false);
  expect(sourceEvidence({ ...read, status: 503 }, response)).toEqual([]);
});
