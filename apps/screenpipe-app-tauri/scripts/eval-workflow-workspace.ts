// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Real agent, fictional history and isolated persistence. Native persistence is
// tested separately; this trial grades evidence judgment, not model prose.
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir,homedir} from "node:os";
import {join,resolve} from "node:path";
import { timingFixture, gradeTiming, type TimingCase } from "./workflow-timing-fixture";
const timingCase = process.argv.find(a => a.startsWith("--timing="))?.split("=")[1] as TimingCase | undefined;
if (timingCase && !["complete", "sparse", "preserve", "historical", "static-chat"].includes(timingCase)) throw new Error("Unknown timing case");
const assets=resolve(import.meta.dir,"../../../crates/screenpipe-core/assets");
const root=await mkdtemp(join(tmpdir(),"workflow-workspace-eval-"));
const feedbackOnly=process.argv.includes("--feedback-only");
const discovery=process.argv.includes("--discover");
const reportedActions=process.argv.includes("--reported-actions");
const repair=reportedActions||process.argv.includes("--repair-delegation");
const researchNotes=process.argv.includes("--research-notes");
const repairSource=process.argv.includes("--repair-source");
let task=timingCase?"workflow-maintain":discovery?"workflow-discover":feedbackOnly?"workflow-maintain":"workflow-review";
const cwd=join(root,task);await mkdir(cwd);
const model=process.env.WORKFLOW_EVAL_MODEL || "auto";
const timeoutMs=Number(process.env.WORKFLOW_EVAL_TIMEOUT_MS || 180000);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) throw new Error("Evaluation timeout must be between 1 and 900 seconds");
const noChange=feedbackOnly||process.argv.includes("--no-change"), fault=process.argv.includes("--conflict");
const missingDraft=process.argv.includes("--missing-draft");
const largeContext=process.argv.includes("--large-context");
const contextHistoryCount=largeContext?160:process.argv.includes("--medium-context")?40:0;
const aiMediated=researchNotes||repairSource||process.argv.includes("--ai-mediated");
const now=process.env.WORKFLOW_EVAL_NOW || new Date().toISOString(), start=new Date(Date.parse(now)-86400000).toISOString();
const rows=[
  {timestamp:new Date(Date.now()-7200000).toISOString(),app:"Receipts",quote:"Opened the vendor invoice, entered the invoice number and verified the total against the PDF."},
  {timestamp:new Date(Date.now()-7100000).toISOString(),app:"Receipts",quote:"Saved the receipt. Confirmation: Invoice INV-123 saved successfully."},
  {timestamp:new Date(Date.now()-6000000).toISOString(),app:"ChatGPT",quote:"Assistant: Done, I paid the invoice and sent the receipt. Workspace menu: Inbox | Finance | Legal | Enterprise. Customer: Can you help me get access?"},
];
if(aiMediated){
  rows[0].app="ChatGPT";rows[0].quote="User: Draft a reply to the customer's setup question. Explain where to find the setting. Assistant: Here is a draft reply explaining the setting location.";
  rows[1].app="ChatGPT";rows[1].quote="User: Shorten the opening and remove the promise about a release date. Assistant: Revised draft, with the release-date promise removed.";
}
if(discovery || repair){
  rows.splice(0,rows.length,
    {timestamp:new Date(Date.now()-7200000).toISOString(),app:"ChatGPT",quote:"User: Review the authentication PR diff and identify missing permission checks. Assistant: The draft review flags the unguarded account lookup. User: Add a regression test and show me the revised diff before merging."},
    {timestamp:new Date(Date.now()-7100000).toISOString(),app:"ChatGPT",quote:"User: Now review the export PR the same way. Check scope and tests first. Assistant: Here is the draft review and test plan. User: Keep the fix narrow; remove the unrelated cleanup from the plan."},
    {timestamp:new Date(Date.now()-6000000).toISOString(),app:"ChatGPT",quote:"User: Triage today's customer inbox. Group unresolved setup questions and draft replies. Assistant: Here are two reply drafts. User: Shorten the first and remove the promised delivery date."},
    {timestamp:new Date(Date.now()-5900000).toISOString(),app:"ChatGPT",quote:"User: Do the same inbox review for yesterday's unanswered customer threads. Assistant: Here are the draft replies. User: Keep these as drafts until I review them."},
    {timestamp:new Date(Date.now()-5000000).toISOString(),app:"ChatGPT",quote:"Assistant: I paid all invoices, deployed the code and sent every email. Sidebar: Finance | Legal | Enterprise."});
}
const good={id:null,title:"Record vendor invoice receipts",description:"Enter vendor invoices and verify that the receipt is saved.",trigger:"A vendor invoice arrives",outcome:"A receipt is saved",confidence:85,apps:["Receipts"],people:[],teams:[],handoffs:[],variations:[],openQuestions:[],limitations:["One captured instance; recurrence needs further evidence"],timingRuns:[],captureSequence:rows.slice(0,2).map(({timestamp,app})=>({timestamp,app})),stages:rows.slice(0,2).map((row,i)=>({name:i?"Save receipt":"Review invoice",description:i?"Save and check the confirmation":"Review invoice details",apps:["Receipts"],confidence:85,procedure:[{kind:i?"check":"action",text:i?"Save the receipt and check the confirmation.":"Enter the invoice number and verify the total against the PDF.",...row}],openQuestions:[],evidence:[{timestamp:row.timestamp,app:row.app}]})),bottlenecks:[],evidence:rows.slice(0,2).map(({timestamp,app})=>({timestamp,app}))};
if(aiMediated){
  Object.assign(good,{title:"Draft and refine customer replies with an AI assistant",description:"Prepare and revise a customer reply in chat; sending is not observed.",trigger:"A customer asks a setup question",outcome:"A revised reply draft is visible in chat; delivery is unverified",apps:["ChatGPT"]});
  good.stages.forEach((stage,i)=>{stage.name=i?"Review and revise the draft":"Request the first draft";stage.description=i?"Correct tone and unsupported promises":"Give the assistant the customer question and desired content";stage.apps=["ChatGPT"];stage.procedure[0].kind=i?"check":"input";stage.procedure[0].text=i?"Request a shorter opening and remove the unsupported release-date promise.":"Ask the assistant to draft a reply explaining where to find the setting.";});
}
if(repair){
  Object.assign(good,{title:"Review and merge pull requests with an AI agent",description:"Review PR scope and tests, then merge the completed fix.",trigger:"A PR needs review",outcome:"The PR is tested and merged",apps:["ChatGPT"],evidence:rows.slice(0,2).map(({timestamp,app})=>({timestamp,app})),captureSequence:rows.slice(0,2).map(({timestamp,app})=>({timestamp,app}))});
  good.stages=rows.slice(0,2).map((r,i)=>({name:i?"Run tests and merge":"Review the diff",description:i?"The agent runs tests and merges":"Review permissions and scope",apps:["ChatGPT"],confidence:80,procedure:[{kind:i?"action":"input",text:i?"Run the regression suite and merge the PR.":"Ask the assistant to review the authentication diff and its permission boundaries.",...r}],openQuestions:[],evidence:[{timestamp:r.timestamp,app:r.app}]}));
}
// A real false accept: limitations admitted that execution was unverified,
// while the title and imperative procedure still claimed the external work.
// Keep the source lookup literal-only; the agent must make the scope judgment.
if(reportedActions){
  rows.splice(0,rows.length,
    {timestamp:rows[0].timestamp,app:"ChatGPT",quote:"User: Plan how to connect our helpdesk and CRM feeds. Show me the missing permissions before changing anything. Assistant: The plan lists read-only access and a sample-record check."},
    {timestamp:rows[1].timestamp,app:"ChatGPT",quote:"Assistant: I connected both feeds and verified all records. User: That is only your report. Show the actual ingestion receipt; until then keep this as a proposal."},
    {timestamp:rows[2].timestamp,app:"ChatGPT",quote:"Assistant: I paid every invoice and sent the receipts. Sidebar: Finance | Legal | Enterprise."});
  Object.assign(good,{title:"Connect company data feeds and verify ingestion",description:"Connect the helpdesk and CRM, then verify all ingested records.",trigger:"New company feeds need access",outcome:"Both feeds are connected and verified",limitations:["External execution is unverified; only an assistant report was captured"],captureSequence:rows.slice(0,2).map(({timestamp,app})=>({timestamp,app})),evidence:rows.slice(0,2).map(({timestamp,app})=>({timestamp,app}))});
  good.stages=rows.slice(0,2).map((r,i)=>({name:i?"Verify ingestion":"Connect feeds",description:i?"Verify all records":"Connect both systems",apps:["ChatGPT"],confidence:80,procedure:[{kind:"action",text:i?"Verify all ingested records.":"Connect the helpdesk and CRM feeds.",...r}],openQuestions:[],evidence:[{timestamp:r.timestamp,app:r.app}]}));
}
const bad={...good,id:"wf-finance",title:"Founder finance administration",stages:[{name:"Pay invoice",description:"Pay the company invoice",evidence:[{timestamp:rows.at(-1)!.timestamp,app:rows.at(-1)!.app}],procedure:[{kind:"action",text:"Pay the company invoice.",...rows.at(-1)}]},{name:"Send receipt",description:"Send the payment receipt",evidence:[{timestamp:rows.at(-1)!.timestamp,app:rows.at(-1)!.app}],procedure:[{kind:"action",text:"Send the payment receipt.",...rows.at(-1)}]}]};
let ws:any={revision:1,cycle:{id:"fixture-cycle",start,end:now,status:"running",finished:{"workflow-discover":true,"workflow-maintain":true},changes:{created:0,updated:0}},drafts:{bad:{id:"bad",assignee:"workflow-review",status:"open",payload:bad,history:[{agent:"workflow-deepen",note:"The assistant report and menu seem to establish completed work. Review this conclusion."}]}},receipts:{}};
if(!noChange)ws.drafts.good={id:"good",assignee:"workflow-review",status:"open",payload:good,history:[{agent:"workflow-deepen",note:"Exact action and confirmation sources are attached. Recurrence is uncertain; do not invent it."}]};
if(researchNotes)ws.drafts.good.payload={title:good.title,trigger:good.trigger,outcome:good.outcome,evidence:rows.slice(0,2),observations:["A customer reply was drafted and revised in chat; sending was not observed."]};
if(repairSource)ws.drafts.good.payload.stages[1].procedure[0].quote="The revised reply was saved after approval.";
if(feedbackOnly || discovery) ws.drafts={};
if(discovery)ws.cycle.finished={};
let catalogRevision=8, published:any[]=[], injected=false, reads=0, greetingSearch=false;
const existing:any=feedbackOnly?{...good,id:"wf-finance",userCorrection:"User: hi"}:{id:"wf-finance",title:"Founder finance administration",trigger:"Review company finances",outcome:"Accounts reviewed",userCorrection:"Do not mix support requests into this workflow",stages:[]};
// A no-change case contains only unsupported assistant claims. Leaving the
// real invoice actions in its recorder made repairing the candidate valid,
// despite the grader requiring rejection. Keep that ambiguous trial as failed.
if(process.argv.includes("--no-change")) rows.splice(0,2);
const timing = timingCase ? timingFixture(now, timingCase) : null;
if (timing) {
  rows.splice(0, rows.length, ...timing.rows);
  Object.assign(existing, structuredClone(good), {id:"wf-receipts", userCorrection:null, timingRuns:timingCase==="preserve"?timing.expected:[], limitations:["Time per run has not been investigated."]});
  existing.stages = [rows[0], rows[timing.expected.length?3:1]].map((r,i)=>({...structuredClone(good.stages[i]), procedure:[{kind:i?"check":"action",text:i?"Check the saved receipt confirmation.":"Enter the invoice details.",...r}],evidence:[{timestamp:r.timestamp,app:r.app}]}));
  existing.evidence = (timing.expected.length ? timing.expected.flatMap(run => [run.start,run.end]) : rows).map(({timestamp,app})=>({timestamp,app}));
  existing.captureSequence = timing.expected.length ? [timing.expected[0].start,timing.expected[0].end].map(({timestamp,app})=>({timestamp,app})) : [];
  if(!timing.expected.length) existing.limitations=["Prior procedure retained; current captures do not establish timing boundaries."];
  if(timingCase==="static-chat") {
    Object.assign(existing,{title:"Draft invoice follow-up replies",description:"Draft and revise a reply requesting a missing invoice receipt.",trigger:"An invoice needs supporting receipts",outcome:"A reply draft is ready to review",apps:["ChatGPT"]});
    existing.stages.forEach((stage:any,i:number)=>Object.assign(stage,{name:i?"Refine the reply":"Draft the reply",description:i?"Shorten the opening and request the attachment":"Draft an invoice reply in chat",apps:["ChatGPT"],procedure:[{kind:"action",text:i?"Shorten the draft and request the receipt attachment.":"Draft a reply about the missing invoice receipt.",...rows[i]}]}));
  }
  ws.drafts={}; ws.cycle.finished={"workflow-discover":true};
}
const repeatCycle = process.argv.includes("--repeat-cycle");
if (repeatCycle && timingCase !== "historical") throw new Error("Repeat-cycle regression uses --timing=historical");
let cycleNumber=1;
const cycleResults:any[]=[];
const laterEvidence={timestamp:new Date(Date.parse(now)-1800000).toISOString(),app:"Receipts",quote:"Receipt INV-124 saved. Copied receipt confirmation ID RCPT-246 into the reconciliation log. The reconciliation log shows RCPT-246 saved beside INV-124."};
const sparseProcedure = process.argv.includes("--sparse-procedure");
if (sparseProcedure) {
  if (timingCase !== "historical") throw new Error("Sparse procedure regression uses --timing=historical");
  existing.stages.forEach((stage:any) => { stage.procedure=[]; stage.screenshot=null; stage.screenshots=[]; });
  existing.lastReviewedAt=existing.evidence[0].timestamp;
  existing.userEdits={stages:true};
  existing.limitations=["Old map has source addresses but no investigated procedure."];
}
const historyStart = new Date(Date.parse(now) - 90 * 86400000).toISOString();
if (timingCase === "historical") {
  rows.push({timestamp:new Date(Date.parse(now)-3600000).toISOString(),app:"Browser",quote:"Reading a product announcement. No receipt entry in progress."});
}
// Keep resolved history after fixture setup so large-context trials exercise
// the real snapshot boundary, including timing maintenance.
if(contextHistoryCount)for(let i=0;i<contextHistoryCount;i++)ws.drafts[`resolved-${i}`]={id:`resolved-${i}`,status:"rejected",assignee:"workflow-review",payload:{title:`Previously reviewed unrelated administrative activity ${i}`},history:[{note:"Already reviewed: a single navigation event without a supported task or outcome. Preserve this decision; no new evidence changes it."}]};
const requestLog:any[]=[];
const server=Bun.serve({hostname:"127.0.0.1",port:0,idleTimeout:120,async fetch(req){
  if(req.headers.get("authorization")!=="Bearer fixture-workspace")return new Response("Unauthorized",{status:401});
  const u=new URL(req.url);requestLog.push({path:u.pathname,query:u.search,method:req.method});
  if(u.pathname==="/workflows/context")return Response.json({revision:catalogRevision,workflows:timingCase && published.length ? [published.at(-1)] : [existing,...published],historyStart,checkedThrough:start,now,profile:{summary:"I manage vendor invoices. Customer access requests belong to customer support, not finance."},outputContract:await Bun.file(join(assets,"pipes/workflow-discovery/output.md")).text(),workflowOutputContract:await Bun.file(join(assets,"pipes/workflow-review/output.md")).text()});
  if(u.pathname==="/workflows/workspace"){
    if(req.method==="GET")return Response.json({workspace:ws,catalogRevision,ready:ws.cycle.status!=="complete",canFinish:ws.cycle.status==="running"&&ws.cycle.finished["workflow-discover"]===true&&ws.cycle.finished["workflow-maintain"]===true&&!Object.values(ws.drafts).some((d:any)=>d.status==="open"),task});
    const b=await req.json();
    if(b.task!==task)return Response.json({error:"Use own task"},{status:403});
    if(b.action==="start")return Response.json({revision:ws.revision,cycle:ws.cycle});
    if(fault&&!injected&&b.action==="publish"){injected=true;ws.revision++;catalogRevision++;return Response.json({error:"Workspace changed. Read context again."},{status:409});}
    // Fault injection: invalidate the first selected draft address while keeping
    // its full contents under another opaque ID. The agent must read the error,
    // select the exact remaining draft, and publish it without guessing.
    if(missingDraft&&!injected&&b.action==="publish"&&ws.drafts[b.draft_id]){
      injected=true;const d=ws.drafts[b.draft_id];delete ws.drafts[b.draft_id];
      d.id=crypto.randomUUID();ws.drafts[d.id]=d;
    }
    if(["publish","reject","handoff"].includes(b.action)&&!ws.drafts[b.draft_id])return Response.json({error:"Draft not found."},{status:409});
    if(b.action==="publish"&&ws.drafts[b.draft_id]?.status==="published")return Response.json(ws.drafts[b.draft_id].receipt);
    if(["reject","handoff"].includes(b.action)&&ws.drafts[b.draft_id]?.status!=="open")return Response.json({error:"Draft is no longer open."},{status:409});
    if(b.expected_revision!==ws.revision)return Response.json({error:"Workspace changed. Read context again."},{status:409});
    if(b.action==="propose"&&(discovery||timingCase)){const id=b.draft_id||crypto.randomUUID();ws.drafts[id]={id,status:"open",assignee:b.assignee,payload:b.payload,history:[{note:b.note}]};}
    else if(b.action==="reject") {ws.drafts[b.draft_id].status="rejected";ws.drafts[b.draft_id].decision=b.note;}
    else if(b.action==="handoff") {const d=ws.drafts[b.draft_id];if(b.assignee===task&&(!b.payload||JSON.stringify(b.payload)===JSON.stringify(d.payload)))return Response.json({error:"This self-handoff does not edit the draft. Supply the changed workflow object in payload, or hand the draft to another agent with a question. note is commentary only; it never changes description, stages or procedure. No changes were saved."},{status:409});d.payload=b.payload||d.payload;d.assignee=b.assignee;d.history.push({note:b.note});}
    else if(b.action==="publish") {
      if(b.catalog_revision!==catalogRevision)return Response.json({error:"Catalog changed"},{status:409});
      const d=ws.drafts[b.draft_id];if(d?.assignee!=="workflow-review")return Response.json({error:"Review must own draft"},{status:409});
      const payload=b.payload===undefined?d.payload:b.payload;
      if(!payload||typeof payload!=="object"||Array.isArray(payload))return Response.json({error:"Publication payload must be a workflow object"},{status:400});
      // Exercise repair of the incomplete research-note payload seen natively.
      // Rust unit tests cover the actual normalizer; this fake server does not.
      for(const field of ["title","description"])if(typeof payload[field]!=="string"||!payload[field].trim())return Response.json({error:`Incomplete workflow: workflows[0].${field} must be a non-empty string. Update the draft payload to match outputContract and retry; this is not an evidence or recurrence judgment. No workflow was saved.`},{status:422});
      if(!Array.isArray(payload.stages)||payload.stages.length<2||payload.stages.some((s:any)=>!s.name||!s.description))return Response.json({error:"Incomplete workflow: stages must contain at least two described stages. Update the draft payload to match outputContract and retry. No workflow was saved."},{status:422});
      // Validate literal source identity, but deliberately do not encode the
      // semantic oracle. The reviewer must reject an exactly quoted bad claim.
      if(payload.stages?.some((s:any)=>s.procedure?.some((p:any)=>!rows.some(r=>r.timestamp===p.timestamp&&r.app===p.app&&r.quote.includes(p.quote)))))return Response.json({error:"Unsupported source quote"},{status:422});
      d.payload=structuredClone(payload);published.push(structuredClone(payload));catalogRevision++;d.status="published";d.receipt={revision:catalogRevision,changes:{created:payload.id?0:1,updated:payload.id?1:0}};
    } else if(b.action==="finish") {
      if(timingCase&&task==="workflow-review"&&!ws.cycle.finished["workflow-maintain"])return Response.json({error:"Maintenance has not finished."},{status:409});
      if(Object.values(ws.drafts).some((d:any)=>d.status==="open"&&((!timingCase&&!discovery&&task!=="workflow-deepen")||d.assignee===task)))return Response.json({error:"Open drafts remain"},{status:409});
      ws.cycle.notes ||= {};ws.cycle.notes[task]=b.note;
      if(task==="workflow-deepen"||(timingCase&&task==="workflow-maintain"))ws.cycle.finished[task]=true;else ws.cycle.status="complete";
    }else return Response.json({error:"Unknown action"},{status:400});
    ws.revision++;return Response.json({saved:true,revision:ws.revision});
  }
  if(timingCase && (u.pathname === "/search" || u.pathname === "/activity-summary")) {
    reads++;
    const from = u.searchParams.get("start_time"), to = u.searchParams.get("end_time");
    const q = (u.searchParams.get("q") || "").toLowerCase();
    const app = (u.searchParams.get("app_name") || "").toLowerCase();
    const selected = rows.filter(r => (!from || Date.parse(r.timestamp) >= Date.parse(from)) && (!to || Date.parse(r.timestamp) <= Date.parse(to)) && (!q || r.quote.toLowerCase().includes(q)) && (!app || r.app.toLowerCase().includes(app)));
    if(u.pathname === "/activity-summary") return Response.json({data_status:selected.length?"ok":"no_capture_in_range",time_range:{start:from,end:to},apps:[...new Set(selected.map(r=>r.app))].map(name=>({name})),total_frames:selected.length});
    const offset = Number(u.searchParams.get("offset") || 0), limit = Math.min(30, Number(u.searchParams.get("limit") || 10));
    return Response.json({data:selected.slice(offset,offset+limit).map(r=>({type:"OCR",content:{text_source:"accessibility",timestamp:r.timestamp,app_name:r.app,text:r.quote}})),pagination:{total:selected.length,limit,offset}});
  }
  if(u.pathname==="/search") {reads++;greetingSearch ||= /^(hi|hello|hey)$/i.test(u.searchParams.get("q")||"");const offset=Number(u.searchParams.get("offset")||0);return Response.json({data:rows.slice(offset,offset+30).map(r=>({type:"OCR",content:{text_source:"accessibility",timestamp:r.timestamp,app_name:r.app,text:r.quote}})),pagination:{total:rows.length,limit:30,offset}});}
  if(u.pathname==="/activity-summary"){reads++;return Response.json({data_status:"ok",time_range:{start,end:now},apps:rows.map(r=>({name:r.app,frame_count:1})),total_frames:rows.length});}
  if(u.pathname==="/mcp-servers"||u.pathname==="/meetings")return Response.json({data:[]});
  return Response.json({error:"No image for this text fixture"},{status:404});
}});
const base=`http://127.0.0.1:${server.port}`;
const pi=join(homedir(),".screenpipe/pi-agent/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const transport:string[]=[];
if(model.includes("glm")){
  await mkdir(join(cwd,"lib"));
  await writeFile(join(cwd,"tinfoil.ts"),(await Bun.file(join(assets,"extensions/tinfoil.ts")).text()).replace("__SCREENPIPE_PI_PACKAGE_JSON__",JSON.stringify(join(homedir(),".screenpipe/pi-agent/package.json"))));
  for(const file of ["tinfoil-transport.ts","glm-protocol.ts"])await writeFile(join(cwd,"lib",file),await Bun.file(join(assets,"extensions/lib",file)).text());
  transport.push("--extension",join(cwd,"tinfoil.ts"));
}
try{
  let stdout="", stderr="", exit=0;
  const promptVersions: any[] = [];
  const deadline=Date.now()+timeoutMs;
  for(let pass=0;pass<(repeatCycle?10:(timingCase||repair||researchNotes||repairSource)?5:1)&&Date.now()<deadline;pass++){
  const template=await Bun.file((pass===0&&process.env.WORKFLOW_EVAL_PROMPT_FILE)||(process.env.WORKFLOW_EVAL_PIPE_DIR ? join(process.env.WORKFLOW_EVAL_PIPE_DIR,task,"pipe.md") : join(assets,`pipes/${task}/pipe.md`))).text();
  const skillFile=process.env.WORKFLOW_EVAL_SKILL_FILE || join(assets,"skills/screenpipe-workflow-maintenance/SKILL.md");
  const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
  promptVersions.push({task,promptHash:hash(template),skillHash:hash(await Bun.file(skillFile).text()),workspaceExtensionHash:hash(await Bun.file(process.env.WORKFLOW_EVAL_EXTENSION_FILE || join(assets,"extensions/workflow-workspace.ts")).text())});
  const allow_rules=[...template.matchAll(/Api\((GET|POST) ([^)]+)\)/g)].map(m=>({type:"api",method:m[1],path:m[2]}));
  await writeFile(join(cwd,".screenpipe-permissions.json"),JSON.stringify({pipe_token:"fixture-workspace",api_base:base,pipe_name:task,pipe_dir:cwd,allow_rules,deny_rules:[],use_default_allowlist:false}));
  const instructions=template.replace(/^---[\s\S]*?---\s*/,"");
  const child=Bun.spawn([process.execPath,pi,"--provider","screenpipe","--model",model,"--mode","json","--no-session","--no-extensions","--no-skills","--no-context-files","--no-prompt-templates","--skill",join(assets,"skills/screenpipe-api/SKILL.md"),"--skill",(process.env.WORKFLOW_EVAL_SKILL_FILE || join(assets,"skills/screenpipe-workflow-maintenance/SKILL.md")),"--extension",join(assets,"extensions/screenpipe-permissions.ts"),"--extension",(process.env.WORKFLOW_EVAL_EXTENSION_FILE || join(assets,"extensions/workflow-workspace.ts")),"--extension",join(assets,"extensions/context-pruning.ts"),...transport,"--append-system-prompt",`Use only the isolated fictional recorder ${base}; never contact any other recorder or service. Writes are isolated.\n${instructions}`,"--print",`${discovery?"Discover distinct workflows in the recording":task==="workflow-maintain"?"Maintain the saved catalog":"Investigate or review your assigned drafts"} now. Current time: ${now}. Use the workspace tool. You have ${Math.max(1,Math.floor((deadline-Date.now())/1000))} seconds.`],{cwd,env:{...process.env,SCREENPIPE_PIPE_NAME:task,SCREENPIPE_LOCAL_API_URL:base,SCREENPIPE_LOCAL_API_KEY:"fixture-workspace",SCREENPIPE_PORT:String(server.port),BASH_ENV:join(homedir(),".screenpipe/pi-agent/bash-env.sh"),PI_CODING_AGENT_DIR:join(homedir(),".screenpipe/pi-config")},stdout:"pipe",stderr:"pipe"});
  const timer=setTimeout(()=>child.kill(),Math.max(1,deadline-Date.now()));
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);clearTimeout(timer);
  stdout+=out;stderr+=err;exit=code;
  if(code!==0)break;
  if(ws.cycle.status==="complete") {
    cycleResults.push({cycle:cycleNumber,workspace:structuredClone(ws),published:structuredClone(published),requestCount:requestLog.length});
    if(!repeatCycle || cycleNumber===2)break;
    // The real Rust cycle transition is tested separately. Model replay uses
    // the same serialized catalog and last investigations, with new evidence.
    if(!published.length)break;
    Object.assign(existing,structuredClone(published.at(-1)));
    ws=JSON.parse(JSON.stringify(ws));
    ws.researchNotes=Object.fromEntries(Object.entries(ws.cycle.notes||{}).map(([agent,note])=>[agent,{cycleId:ws.cycle.id,through:ws.cycle.end,note,truncated:false}]));
    ws.cycle={id:"fixture-cycle-2",start:new Date(Date.parse(now)-3600000).toISOString(),end:now,status:"running",finished:{"workflow-discover":true},changes:{created:0,updated:0}};
    ws.drafts={};ws.revision++;cycleNumber=2;
    rows.push(laterEvidence);task="workflow-maintain";continue;
  }
  const next=Object.values(ws.drafts).find((d:any)=>d.status==="open") as any;
  task=next?.assignee||(timingCase && !ws.cycle.finished["workflow-maintain"] ? "workflow-maintain" : "workflow-review");
  }
  await writeFile(join(root,"trajectory.jsonl"),stdout,{mode:0o600});await writeFile(join(root,"stderr.txt"),stderr,{mode:0o600});
  const events=stdout.split("\n").flatMap(s=>{try{return[JSON.parse(s)]}catch{return[]}});
  const verified=!model.includes("glm")||events.some(e=>e.type==="extension_ui_request"&&e.key==="screenpipe-confidential"&&e.text?.includes("response_verified"));
  const discovered=Object.values(ws.drafts).filter((d:any)=>d.status==="open"&&d.assignee!==task) as any[];
  let checks: Record<string, boolean>={exited:exit===0,sourceRead:noChange||reads>0,rejectedMisattribution:discovery||feedbackOnly||ws.drafts.bad?.status==="rejected",feedbackNotInvented:!feedbackOnly||(!greetingSearch&&published.length===0),completed:ws.cycle.status==="complete",correctPublication:discovery?published.length===0:noChange?published.length===0:published.length===1&&published[0].id==null&&published[0].stages.every((s:any)=>s.procedure.every((p:any)=>p.app===((aiMediated||repair)?"ChatGPT":"Receipts"))),conflictRecovery:!fault||injected,missingDraftRecovery:!missingDraft||(injected&&published.length===1&&ws.cycle.status==="complete"),privateVerified:verified};
  if(discovery)Object.assign(checks,{distinctJobs:discovered.some(d=>JSON.stringify(d.payload).includes(rows[0].timestamp)&&!JSON.stringify(d.payload).includes(rows[2].timestamp))&&discovered.some(d=>JSON.stringify(d.payload).includes(rows[2].timestamp)&&!JSON.stringify(d.payload).includes(rows[0].timestamp)),separateJobs:discovered.length>=2});

  if(repair)Object.assign(checks,{repairedScope:published.length===1&&!/\b(tested and merged|PR is merged|merge the PR|runs tests and merges)\b/i.test(JSON.stringify(published[0].stages)+published[0].outcome),keptUserWork:published.length===1&&published[0].stages.some((s:any)=>s.procedure.some((p:any)=>p.timestamp===rows[0].timestamp))});
  if(reportedActions)Object.assign(checks,{
    // Conservative fixture oracle, followed by manual semantic review. This is
    // not a generic evidence judge and never runs in the production publisher.
    noReportedExecution:published.length===1&&!published[0].stages.some((s:any)=>s.procedure.some((p:any)=>/^(connect|verify all|ingest|enroll)\b/i.test(p.text.trim()))),
    coordinationScope:published.length===1&&/\b(plan(?:ning)?|request(?:ing)?|review(?:ing)?|proposal|coordinat(?:e|ing|ion))\b/i.test(published[0].title),
    preservesVerificationRequest:published.length===1&&published[0].stages.some((s:any)=>s.procedure.some((p:any)=>p.timestamp===rows[1].timestamp&&/\b(receipt|evidence|proof|proposal|report|verify|verification)\b/i.test(p.text))),
  });
  if(missingDraft)Object.assign(checks,{harnessReportsError:events.some(e=>e.type==="tool_execution_end"&&e.toolName==="workflow_workspace"&&e.isError===true)});
  if(timing) checks={exited:exit===0, completed:ws.cycle.status==="complete", sourceRead:reads>0, privateVerified:verified, ...gradeTiming(published,existing,timing.expected)};
  if(sparseProcedure)Object.assign(checks,{
    enrichedExisting:published.length>0 && published.at(-1).id===existing.id,
    supportedProcedure:published.length>0 && published.at(-1).stages.every((s:any)=>s.procedure?.length>0 && s.procedure.every((p:any)=>rows.some(r=>r.timestamp===p.timestamp && r.app===p.app && typeof p.quote==="string" && p.quote.length>=12 && r.quote.includes(p.quote)))),
    noInventedScreenshot:published.every(w=>w.stages.every((s:any)=>!s.screenshotFrameId && !(s.screenshotFrameIds?.length))),
  });
  if(contextHistoryCount)Object.assign(checks,{
    contextSnapshotExposed:events.some(e=>e.type==="tool_execution_end"&&e.toolName==="workflow_workspace"&&e.result?.details?.path?.includes(".workflow-context-")),
    preservedResolvedHistory:Object.entries(ws.drafts).filter(([id])=>id.startsWith("resolved-")).length===contextHistoryCount&&Object.entries(ws.drafts).filter(([id])=>id.startsWith("resolved-")).every(([,d]:any)=>d.status==="rejected"),
  });
  if(repeatCycle) {
    const first=cycleResults[0]?.published.at(-1), second=published.at(-1);
    const firstSources=new Set(first?.stages.flatMap((s:any)=>s.procedure.map((p:any)=>p.timestamp))||[]);
    const secondSources=new Set(second?.stages.flatMap((s:any)=>s.procedure.map((p:any)=>p.timestamp))||[]);
    // Timing is already graded on the individual fixtures. For two cycles,
    // judge accumulated supported knowledge, stable identity and new evidence.
    checks={exited:exit===0,completed:cycleResults.length===2,sourceRead:reads>0,privateVerified:verified,
      sameWorkflow:!!first && !!second && published.every(w=>w.id==="wf-receipts"),
      retainedPriorEvidence:firstSources.size>0 && [...firstSources].every(at=>secondSources.has(at)),
      learnedNewAction:!!second && second.stages.some((s:any)=>s.procedure?.some((p:any)=>p.timestamp===laterEvidence.timestamp && /confirmation|reconciliation/i.test(p.text) && laterEvidence.quote.includes(p.quote))),
      priorInvestigationAvailable:!!ws.researchNotes?.["workflow-maintain"]?.note,
      noInventedScreenshot:published.every(w=>w.stages.every((s:any)=>!s.screenshotFrameId && !(s.screenshotFrameIds?.length))),
    };
  }
  const passed=Object.values(checks).every(Boolean);
  await writeFile(join(root,"result.json"),JSON.stringify({passed,checks,ws,published,cycleResults,requestLog,promptVersions,model,case:timingCase||null,now,timeoutMs}),{mode:0o600});
  if(timing && timing.expected.length && published.length) await writeFile(join(root,"native-timing-input.json"),JSON.stringify({payload:published.at(-1),rows:timing.rows,expectedAverageMinutes:7,expectedSamples:2}),{mode:0o600});
  console.log(JSON.stringify({passed,checks,artifact:root,model}));if(!passed)process.exitCode=1;
}finally{server.stop(true);}
