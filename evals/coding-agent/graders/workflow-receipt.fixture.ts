// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./workflow-workspace";
import { normalizeGlmRequest } from "./lib/glm-protocol";
const compactGlmToolResultText = (content: string): string => normalizeGlmRequest({model:"synthetic", tools:[{type:"function",function:{name:"subagent"}}], messages:[{role:"tool",content}]}).messages[0].content;
async function checked(promise: Promise<any>) { await expect(promise).resolves.toBeDefined(); return promise; }
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
  const result=await checked(tool.execute("id",{action:"handoff",expected_revision:1,draft_id:"a",assignee:"workflow-review",note:"checked",payload},new AbortController().signal));
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
  const result=await checked(tool.execute("id",{action:"context"},new AbortController().signal));
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
  await expect(tool.execute("id",{action:"context",draft_id:"missing"},new AbortController().signal)).rejects.toThrow("not found");
});
test("oversized selected context is preserved in a private readable snapshot",async()=>{
  const {draft}=contextFixture({title:"Invoice review",evidence:"exact source ".repeat(4000)});
  const result=await checked(tool.execute("id",{action:"context",draft_id:"draft-a"},new AbortController().signal));
  const pointer=JSON.parse(result.content[0].text);
  expect(result.content[0].text.length).toBeLessThan(24000);
  expect(JSON.parse(readFileSync(pointer.path,"utf8")).draft).toEqual(draft);
  expect(statSync(pointer.path).mode & 0o777).toBe(0o600);
  expect(pointer.revision).toBe(7);expect(pointer.catalogRevision).toBe(4);
});
test("medium context survives the Private transport with an exact snapshot",async()=>{
  const {draft}=contextFixture({title:"Invoice review",evidence:"source fragment ".repeat(800)});
  const result=await checked(tool.execute("id",{action:"context",draft_id:"draft-a"},new AbortController().signal));
  // The native failure lived between the old 24K inline limit and Private's
  // 8K tool-text limit: its JSON became unparseable, with no snapshot to read.
  const delivered=compactGlmToolResultText(result.content[0].text);
  expect(()=>JSON.parse(delivered)).not.toThrow();
  const pointer=JSON.parse(delivered);
  expect(delivered).toBe(result.content[0].text);
  expect(JSON.parse(readFileSync(pointer.path,"utf8")).draft).toEqual(draft);
  expect(pointer.revision).toBe(7);
  expect(pointer.catalogRevision).toBe(4);
});

test("mistyped draft selectors return exact owned ids without substituting or writing",async()=>{
  contextFixture();
  const error=await tool.execute("id",{action:"context",draft_id:"draft-b"},new AbortController().signal).catch((e:Error)=>e);
  expect(error).toBeInstanceOf(Error);expect(error.message).toContain("draft-a");expect(error.message).toContain("Invoice review");
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
});


test("publication returns remaining work with current revisions, distinct from its save receipt",async()=>{
  server.reload({fetch:(req:Request)=>Response.json(req.method==="POST"
    ? {revision:8,changes:{created:1},checkedThrough:"previous-window"}
    : {workspace:{revision:12,cycle:{status:"running"},drafts:{done:{status:"published"}}},catalogRevision:8,canFinish:true})});
  const result=await checked(tool.execute("id",{action:"publish",expected_revision:1,catalog_revision:1,draft_id:"done"},new AbortController().signal));
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content[0].text)).toMatchObject({revision:8,remaining:{revision:12,catalogRevision:8,cycleStatus:"running",canFinish:true,openDrafts:[]}});
});
test("a failed state read after saving preserves the successful receipt",async()=>{
  let writes=0;
  server.reload({fetch:(req:Request)=>{
    if(req.method==="POST"){writes++;return Response.json({revision:8,changes:{created:1}});}
    return Response.json({error:"Recorder unavailable"},{status:503});
  }});
  const result=await checked(tool.execute("id",{action:"publish",expected_revision:1,catalog_revision:1,draft_id:"done"},new AbortController().signal));
  expect(result.isError).not.toBe(true);expect(writes).toBe(1);
  expect(JSON.parse(result.content[0].text)).toMatchObject({revision:8,remaining:{unavailable:true}});
});
