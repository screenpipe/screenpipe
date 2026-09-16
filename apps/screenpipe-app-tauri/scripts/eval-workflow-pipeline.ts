// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Real installed Pi/account; fictional recorder and temporary stage artifacts.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { resolve, join } from "node:path";
const assets = resolve("../../crates/screenpipe-core/assets");
const tasks = ["workflow-activity", "workflow-patterns", "workflow-procedures", "workflow-timing", "workflow-discovery"];
const directory = await mkdtemp(join(tmpdir(), "workflow-pipeline-eval-"));
const now = new Date().toISOString(), start = new Date(Date.now()-3*3600000).toISOString();
const records = [1,2].flatMap(day => {
  const begin = Date.now()-day*3600000;
  return [
    {type:"OCR",content:{text_source:"accessibility",timestamp:new Date(begin).toISOString(),app_name:"Receipts",text:`Started processing vendor invoice INV-${day} for ExampleCo. Opened its receipt entry form.`}},
    {type:"OCR",content:{text_source:"accessibility",timestamp:new Date(begin+60000).toISOString(),app_name:"Receipts",text:`Processing invoice INV-${day}. Entered vendor ExampleCo and invoice number, checked the total, selected Save receipt.`}},
    {type:"OCR",content:{text_source:"accessibility",timestamp:new Date(begin+120000).toISOString(),app_name:"Receipts",text:`Invoice INV-${day}: receipt saved successfully. Processing complete, returned to inbox.`}},
  ];
});
records.push({type:"OCR",content:{text_source:"accessibility",timestamp:new Date(Date.now()-1800000).toISOString(),app_name:"Personal shopping",text:"Personal purchase: choosing a birthday gift for my sister. Added a novel to personal wishlist."}});
let busy = true;
let stageIndex = 0;
const outputs: any[] = [];
let final: any;
const server = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req) {
  if(req.headers.get("authorization") !== "Bearer fictional-pipeline") return new Response("Unauthorized",{status:401});
  const url = new URL(req.url);
  if(url.pathname === "/workflows/context") return Response.json({revision:0,now,historyStart:start,checkedThrough:null,profile:{summary:"I manage vendor receipts for ExampleCo. Personal shopping is unrelated."},workflows:[],outputContract:await Bun.file(join(assets,"pipes/workflow-discovery/output.md")).text()});
  if(url.pathname === "/workflows/pipeline") {
    if(req.method === "POST") {
      const body = await req.json();
      if(body.task !== tasks[stageIndex] || body.expected_revision !== stageIndex || body.input_revision !== stageIndex || !Array.isArray(body.items) || body.checked_through !== now) return Response.json({error:"Use the exact current stage revision and checkpoint."},{status:409});
      if(!body.coverage?.length || body.coverage.some((range:any)=>range.complete!==true)) return Response.json({error:"Finish reading all pages before advancing coverage. Each interval requires start, end, complete:true."},{status:422});
      outputs[stageIndex] = {revision:stageIndex+1,checkedThrough:now,items:body.items,coverage:body.coverage};
      return Response.json({revision:stageIndex+1,checkedThrough:now});
    }
    return Response.json({task:tasks[stageIndex],stage:stageIndex,revision:stageIndex,inputRevision:stageIndex,ready:true,checkedThrough:now,window:{start,end:now},input:outputs[stageIndex-1] ?? null,previous:null});
  }
  if(url.pathname === "/workflows/catalog") {final = await req.json();return Response.json({revision:1,checkedThrough:now,changes:{created:final.workflows.length,updated:0}});}
  if(url.pathname === "/activity-summary") return Response.json({start_time:start,end_time:now,total_frames:7,apps:[{app_name:"Receipts",frame_count:6},{app_name:"Personal shopping",frame_count:1}]});
  if(url.pathname === "/search") {
    if(busy) { busy=false; return Response.json({error:"recording takes priority",retry_after_ms:100},{status:503}); }
    const offset = Number(url.searchParams.get("offset") || 0);
    // Deliberately return fewer rows than requested; advance by the actual row count.
    return Response.json({data:records.slice(offset,offset+2),pagination:{total:records.length,limit:2,offset}});
  }
  if(url.pathname === "/mcp-servers") return Response.json({data:[]});
  if(url.pathname === "/meetings") return Response.json({data:[],pagination:{total:0,offset:0}});
  return Response.json({error:"No frame imagery exists for this text-only fixture."},{status:404});
}});
try {
  for(stageIndex=0;stageIndex<tasks.length;stageIndex++) {
    const task = tasks[stageIndex], cwd = join(directory,task);
    await mkdir(cwd);
    const prompt = (await Bun.file(join(assets,`pipes/${task}/pipe.md`)).text()).replace(/^---[\s\S]*?---\s*/,"");
    const apiBase = `http://127.0.0.1:${server.port}`;
    const template = await Bun.file(join(assets,`pipes/${task}/pipe.md`)).text();
    const allow_rules = [...template.matchAll(/Api\((GET|POST) ([^)]+)\)/g)].map(match=>({type:"api",method:match[1],path:match[2]}));
    await writeFile(join(cwd,".screenpipe-permissions.json"),JSON.stringify({pipe_token:"fictional-pipeline",api_base:apiBase,pipe_name:task,pipe_dir:cwd,allow_rules,deny_rules:[],use_default_allowlist:false}));
    const child = Bun.spawn([process.execPath,join(homedir(),".screenpipe/pi-agent/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),"--provider","screenpipe","--model","auto","--mode","json","--no-session", "--append-system-prompt", `Use only the fictional recorder at http://127.0.0.1:${server.port} for this evaluation, via SCREENPIPE_LOCAL_API_URL. Never contact port 3030 or any other recorder.`,"--no-extensions","--no-skills","--skill",join(assets,"skills/screenpipe-api/SKILL.md"),"--no-context-files","--no-prompt-templates","--extension",join(assets,"extensions/screenpipe-permissions.ts"),"--extension",join(assets,"extensions/mcp-bridge.ts"),"--extension",join(assets,"extensions/workflow-catalog.ts"),"--print",prompt],{cwd,env:{...process.env,SCREENPIPE_LOCAL_API_URL:apiBase,SCREENPIPE_LOCAL_API_KEY:"fictional-pipeline",SCREENPIPE_PORT:String(server.port),SCREENPIPE_MCP_SERVER_ALLOWLIST:"",SCREENPIPE_PIPE_NAME:task,BASH_ENV:join(homedir(),".screenpipe/pi-agent/bash-env.sh"),PI_CODING_AGENT_DIR:join(homedir(),".screenpipe/pi-config")},stdout:"pipe",stderr:"pipe"});
    const timeout = setTimeout(()=>child.kill(),180000);
    const [stdout,stderr,exit] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);clearTimeout(timeout);
    const saved = stageIndex < 4 ? outputs[stageIndex] : final;
    console.log(JSON.stringify({task,exit,saved:!!saved,items:stageIndex<4?saved?.items.length:final?.workflows.length, classifications:stageIndex===0?saved?.items.map((i:any)=>i.classification):undefined}));
    if(exit !== 0 || !saved || (stageIndex === 3 && !saved.items.length) || (stageIndex === 0 && !saved.items.some((item:any)=>item.classification === "professional"))) {
      const events = stdout.split("\n").flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
      const messages = events.filter(event=>event.type==="agent_end").at(-1)?.messages || [];
      console.log(JSON.stringify({trace:messages.flatMap((message:any)=>message.role==="toolResult" ? [{tool:message.toolName,error:message.isError,text:message.content?.map((part:any)=>part.text||"").join("").slice(0,1200)}] : (Array.isArray(message.content)?message.content:[]).filter((part:any)=>part.type==="toolCall"))}));
      throw new Error(`${task} failed: ${stderr.slice(-1000)}`);
    }
  }
  if(!outputs[0].items.some((item:any)=>item.classification === "personal")) throw new Error("Personal work was not classified separately");
  if(!final.workflows.length || JSON.stringify(final.workflows).toLowerCase().includes("birthday")) throw new Error("Expected supported professional workflow without personal shopping");
  const runs = final.workflows.flatMap((workflow:any)=>workflow.timingRuns || []);
  if(!runs.length) throw new Error("Supported receipt occurrences lost their timing before publication");
  for(const run of runs) {
    for(const boundary of [run.start,run.end]) {
      if(!records.some(row=>row.content.timestamp===boundary?.timestamp && row.content.app_name===boundary?.app && row.content.text.includes(boundary?.quote))) throw new Error("Timing boundary is unsupported");
    }
    if(Date.parse(run.end.timestamp)-Date.parse(run.start.timestamp)!==120000) throw new Error("Timing combined separate receipt occurrences");
  }
  console.log(JSON.stringify({passed:true,stages:outputs.length+1,workflows:final.workflows.length,timingRuns:runs.length}));
} finally {server.stop(true);await rm(directory,{recursive:true,force:true});}
