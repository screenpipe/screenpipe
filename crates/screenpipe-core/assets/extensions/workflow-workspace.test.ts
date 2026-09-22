// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { workflowIndex } from "./workflow-workspace";
import { compactGlmToolResultText } from "./lib/glm-protocol";
let cwd:string, dir:string, originalTask:string|undefined, tool:any, server:any, requests:any[];
beforeEach(()=>{
  cwd=process.cwd();originalTask=process.env.SCREENPIPE_PIPE_NAME;
  dir=mkdtempSync(join(tmpdir(),"workflow-tool-"));process.chdir(dir);
  process.env.SCREENPIPE_PIPE_NAME="workflow-review";requests=[];
  server=Bun.serve({port:0,hostname:"127.0.0.1",fetch:async(req)=>{
    expect(req.headers.get("authorization")).toBe("Bearer fixture-capability");
    const body=req.method==="POST"?await req.json():null;requests.push(body);
    return Response.json({saved:true,revision:2});
  }});
  writeFileSync(join(dir,".screenpipe-permissions.json"),JSON.stringify({api_base:`http://127.0.0.1:${server.port}`,pipe_token:"fixture-capability"}));
  extension({registerTool:(t:any)=>{tool=t}} as any);
});
afterEach(()=>{server.stop(true);process.chdir(cwd);rmSync(dir,{recursive:true});if(originalTask===undefined)delete process.env.SCREENPIPE_PIPE_NAME;else process.env.SCREENPIPE_PIPE_NAME=originalTask;});
test("structured saves serialize quotes and JSON-like source content without shell construction",async()=>{
  const payload={title:'Literal ]} and "quote"',sources:[{quote:'$() `command` \\ \n trailing ]}'}]};
  const result=await tool.execute("id",{action:"handoff",expected_revision:1,draft_id:"a",assignee:"workflow-review",note:"checked",payload},new AbortController().signal);
  expect(result.isError).not.toBe(true);expect(requests[0].payload).toEqual(payload);expect(requests[0].task).toBe("workflow-review");
});
test("server conflicts are errors, not success text",async()=>{
  server.reload({fetch:()=>Response.json({error:"Workspace changed"},{status:409})});
  await expect(tool.execute("id",{action:"publish",expected_revision:1,catalog_revision:1,draft_id:"a"},new AbortController().signal)).rejects.toThrow("Workspace changed");
});
test("missing capability never falls back to a broad owner token",async()=>{
  writeFileSync(join(dir,".screenpipe-permissions.json"),"{}");
  await expect(tool.execute("id",{action:"context"},new AbortController().signal)).rejects.toThrow("Local recorder capability unavailable");
  expect(requests).toHaveLength(0);
});
test("an already-aborted task cannot save",async()=>{
  const abort=new AbortController();abort.abort();
  await expect(tool.execute("id",{action:"publish",expected_revision:1,catalog_revision:1,draft_id:"a"},abort.signal)).rejects.toThrow();
  expect(requests).toHaveLength(0);
});

function contextFixture(payload:any = {title:"Invoice review",evidence:[{quote:"Full source"}]}) {
  const draft={id:"draft-a",status:"open",assignee:"workflow-review",payload,history:[{note:"Check the source"}]};
  const workflow={id:"wf-a",title:"Existing invoice review",stages:[{procedure:[{text:"Existing action"}]}]};
  server.reload({fetch:(req:Request)=>Response.json(new URL(req.url).pathname==="/workflows/workspace"
    ? {workspace:{revision:7,cycle:{id:"cycle",notes:{large:"not in index"}},drafts:{"draft-a":draft}},catalogRevision:4,ready:true}
    : {workflows:[workflow],profile:{},outputContract:"Exact output contract"})});
  return {draft,workflow};
}
test("context index avoids hiding full drafts behind shared harness truncation",async()=>{
  contextFixture({title:"Invoice review",evidence:"x".repeat(40000)});
  const result=await tool.execute("id",{action:"context"},new AbortController().signal);
  const index=JSON.parse(result.content[0].text);
  expect(index.revision).toBe(7);expect(index.catalogRevision).toBe(4);
  expect(index.drafts[0].id).toBe("draft-a");expect(index.drafts[0].payload).toBeUndefined();
  expect(index.workflows[0].stages).toBeUndefined();expect(index.cycle.notes).toBeUndefined();
  expect(result.content[0].text.length).toBeLessThan(24000);
});
test("explicit context selectors preserve the exact draft and catalog record",async()=>{
  const {draft,workflow}=contextFixture();
  const call=async(input:any)=>JSON.parse((await tool.execute("id",{action:"context",...input},new AbortController().signal)).content[0].text);
  expect((await call({draft_id:"draft-a"})).draft).toEqual(draft);
  expect((await call({workflow_id:"wf-a"})).workflow).toEqual(workflow);
  expect((await call({draft_id:"draft-a"})).outputContract).toBe("Exact output contract");
  for (const input of [{draft_id:"draft-a"},{workflow_id:"wf-a"}]) {
    expect((await call(input)).publicationShape).toContain("not publish the outer");
    expect((await call(input)).publicationShape).toContain("outputContract.workflows");
  }
  await expect(tool.execute("id",{action:"context",draft_id:"missing"},new AbortController().signal)).rejects.toThrow("not found");
});
test("oversized selected context is preserved in a private readable snapshot",async()=>{
  const {draft}=contextFixture({title:"Invoice review",evidence:"exact source ".repeat(4000)});
  const result=await tool.execute("id",{action:"context",draft_id:"draft-a"},new AbortController().signal);
  const pointer=JSON.parse(result.content[0].text);
  expect(result.content[0].text.length).toBeLessThan(24000);
  expect(JSON.parse(readFileSync(pointer.path,"utf8")).draft).toEqual(draft);
  expect(statSync(pointer.path).mode & 0o777).toBe(0o600);
  expect(pointer.revision).toBe(7);expect(pointer.catalogRevision).toBe(4);
});
test("medium context survives the Private transport with an exact snapshot",async()=>{
  const {draft}=contextFixture({title:"Invoice review",evidence:"source fragment ".repeat(800)});
  const result=await tool.execute("id",{action:"context",draft_id:"draft-a"},new AbortController().signal);
  // The native failure lived between the old 24K inline limit and Private's
  // 8K tool-text limit: its JSON became unparseable, with no snapshot to read.
  const delivered=compactGlmToolResultText(result.content[0].text);
  const pointer=JSON.parse(delivered);
  expect(delivered).toBe(result.content[0].text);
  expect(JSON.parse(readFileSync(pointer.path,"utf8")).draft).toEqual(draft);
  expect(pointer.revision).toBe(7);
  expect(pointer.catalogRevision).toBe(4);
});

test("mistyped draft selectors return exact owned ids without substituting or writing",async()=>{
  contextFixture();
  await expect(tool.execute("id",{action:"context",draft_id:"draft-b"},new AbortController().signal))
    .rejects.toThrow(/"id":"draft-a","title":"Invoice review"/);
});
test.each(["handoff", "publish", "reject"])("unknown draft %s returns exact candidates but never retries the mutation",async(action)=>{
  let writes=0;
  server.reload({fetch:(req:Request)=>{
    if(req.method==="POST"){writes++;return Response.json({error:"Draft not found."},{status:409});}
    return Response.json({workspace:{drafts:{a:{id:"exact-id",status:"open",assignee:"workflow-review",payload:{title:"Review invoice"}},b:{id:"other-owner",status:"open",assignee:"workflow-deepen"}}}});
  }});
  const error=await tool.execute("id",{action,expected_revision:1,catalog_revision:1,draft_id:"typo",note:"repair"},new AbortController().signal).catch((e:Error)=>e);
  expect(error).toBeInstanceOf(Error);expect(writes).toBe(1);
  expect(error.message).toContain("exact-id");
  expect(error.message).not.toContain("other-owner");
  expect(error.message).toContain("No changes were saved");
});


test("publication returns remaining work with current revisions, distinct from its save receipt",async()=>{
  server.reload({fetch:(req:Request)=>Response.json(req.method==="POST"
    ? {revision:8,changes:{created:1},checkedThrough:"previous-window"}
    : {workspace:{revision:12,cycle:{status:"running"},drafts:{done:{status:"published"}}},catalogRevision:8,canFinish:true})});
  const result=await tool.execute("id",{action:"publish",expected_revision:1,catalog_revision:1,draft_id:"done"},new AbortController().signal);
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content[0].text)).toMatchObject({revision:8,remaining:{revision:12,catalogRevision:8,cycleStatus:"running",canFinish:true,openDrafts:[]}});
});
test("a failed state read after saving preserves the successful receipt",async()=>{
  let writes=0;
  server.reload({fetch:(req:Request)=>{
    if(req.method==="POST"){writes++;return Response.json({revision:8,changes:{created:1}});}
    return Response.json({error:"Recorder unavailable"},{status:503});
  }});
  const result=await tool.execute("id",{action:"publish",expected_revision:1,catalog_revision:1,draft_id:"done"},new AbortController().signal);
  expect(result.isError).not.toBe(true);expect(writes).toBe(1);
  expect(JSON.parse(result.content[0].text)).toMatchObject({revision:8,remaining:{unavailable:true}});
});

test("maintenance index exposes timing coverage and source dates without source text", () => {
  const item = workflowIndex({id:"old",title:"Receipts",evidence:[
    {timestamp:"2026-09-18T12:08:00Z",detail:"private source"},
    {timestamp:"2026-09-18T05:00:00-07:00",detail:"private source"},
    {timestamp:"invalid"}],timingRuns:[{start:{quote:"private"}}]});
  expect(item.timing.runCount).toBe(1);
  expect(item.sourceRange).toEqual({first:"2026-09-18T05:00:00-07:00",last:"2026-09-18T12:08:00Z"});
  expect(JSON.stringify(item)).not.toContain("private");
  expect(workflowIndex({id:"empty",evidence:[],timingRuns:null})).toMatchObject({timing:{runCount:0},sourceRange:null});
});
test("both index and selected workflow retain available history independently of cycle",async()=>{
  server.reload({fetch:(req:Request)=>Response.json(new URL(req.url).pathname==="/workflows/workspace"
    ? {workspace:{revision:7,cycle:{start:"2026-09-20T00:00:00Z",end:"2026-09-21T00:00:00Z"},drafts:{}},catalogRevision:4,ready:true}
    : {historyStart:"2026-06-23T00:00:00Z",workflows:[{id:"old",title:"Receipts",timingRuns:[],evidence:[{timestamp:"2026-09-18T12:00:00Z"}]}],outputContract:"contract"})});
  for(const input of [{action:"context"},{action:"context",workflow_id:"old"}]) {
    const result=JSON.parse((await tool.execute("id",input,new AbortController().signal)).content[0].text);
    expect(result.historyStart).toBe("2026-06-23T00:00:00Z");
    expect(result.cycle.start).toBe("2026-09-20T00:00:00Z");
  }
});

// Missing revisions are invalid input, not a concurrent-write conflict.
test("finish explains missing revisions before making a request and accepts a corrected call",async()=>{
  for(const input of [
    {action:"finish",note:"Done"},
    {action:"finish",expected_revision:"1",note:"Done"},
    {action:"finish",expected_revision:-1,note:"Done"},
  ]) await expect(tool.execute("id",input,new AbortController().signal)).rejects.toThrow("expected_revision is required");
  await expect(tool.execute("id",{action:"finish",expected_revision:1,note:"Done"},new AbortController().signal)).rejects.toThrow("catalog_revision is required");
  expect(requests).toHaveLength(0);
  const result=await tool.execute("id",{action:"finish",expected_revision:1,catalog_revision:4,note:"Done"},new AbortController().signal);
  expect(JSON.parse(result.content[0].text).saved).toBe(true);
  expect(requests[0]).toMatchObject({action:"finish",expected_revision:1,catalog_revision:4});
});
test("Maintenance can finish with its workspace revision without a publication revision",async()=>{
  process.env.SCREENPIPE_PIPE_NAME="workflow-maintain";
  extension({registerTool:(t:any)=>{tool=t}} as any);
  const result=await tool.execute("id",{action:"finish",expected_revision:1,note:"Investigation handed to Review"},new AbortController().signal);
  expect(JSON.parse(result.content[0].text).saved).toBe(true);
  expect(requests[0]).toMatchObject({task:"workflow-maintain",action:"finish",expected_revision:1});
  expect(requests[0].catalog_revision).toBeUndefined();
});
test("workspace selects the single-workflow contract while legacy clients keep the batch contract",async()=>{
  server.reload({fetch:(req:Request)=>Response.json(new URL(req.url).pathname==="/workflows/workspace"
    ? {workspace:{revision:1,drafts:{a:{id:"a",status:"open",assignee:"workflow-review",payload:{}}}},catalogRevision:1}
    : {workflows:[{id:"wf-a"}],outputContract:"legacy batch",workflowOutputContract:"single workflow"})});
  for(const selector of [{draft_id:"a"},{workflow_id:"wf-a"}]) {
    const result=JSON.parse((await tool.execute("id",{action:"context",...selector},new AbortController().signal)).content[0].text);
    expect(result.outputContract).toBe("single workflow");
    expect(result.publicationShape).toContain("one workflow object");
    expect(JSON.stringify(result)).not.toContain("legacy batch");
  }
});
test("batch and workspace contracts describe the same workflow fields",()=>{
  const batch=readFileSync(new URL("../pipes/workflow-discovery/output.md",import.meta.url),"utf8");
  const item=readFileSync(new URL("../pipes/workflow-review/output.md",import.meta.url),"utf8").trim();
  expect(item.startsWith('{"id":')).toBe(true);
  expect(batch).toContain(`"workflows":[${item}]`);
});
