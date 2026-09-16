// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Real installed Pi/account; fictional recorder and temporary stage artifacts.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { resolve, join } from "node:path";
const assets = resolve("../../crates/screenpipe-core/assets");
const tasks = ["workflow-activity", "workflow-patterns", "workflow-procedures", "workflow-timing", "workflow-discovery"];
const directory = await mkdtemp(join(tmpdir(), "workflow-pipeline-eval-"));
const now = new Date().toISOString(), start = new Date(Date.now()-2*86400000).toISOString();
const records = [1,2].map(day => ({type:"OCR",content:{timestamp:new Date(Date.now()-day*3600000).toISOString(),app_name:"Receipts",text:`Vendor receipt ${day} opened. Vendor ExampleCo, invoice INV-${day}. Entered vendor and invoice number. Clicked Save receipt. Receipt saved successfully. Back to inbox.`}}));
records.push({type:"OCR",content:{timestamp:new Date(Date.now()-1800000).toISOString(),app_name:"Personal shopping",text:"Personal purchase: choosing a birthday gift for my sister. Added a novel to personal wishlist."}});
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
      outputs[stageIndex] = {revision:stageIndex+1,checkedThrough:now,items:body.items,coverage:body.coverage};
      return Response.json({revision:stageIndex+1,checkedThrough:now});
    }
    return Response.json({task:tasks[stageIndex],stage:stageIndex,revision:stageIndex,inputRevision:stageIndex,ready:true,checkedThrough:now,window:{start,end:now},input:outputs[stageIndex-1] ?? null,previous:null});
  }
  if(url.pathname === "/workflows/catalog") {final = await req.json();return Response.json({revision:1,checkedThrough:now,changes:{created:final.workflows.length,updated:0}});}
  if(url.pathname === "/activity-summary") return Response.json({start_time:start,end_time:now,total_frames:3,apps:[{app_name:"Receipts",frame_count:2},{app_name:"Personal shopping",frame_count:1}]});
  if(url.pathname === "/search") return Response.json({data:records,pagination:{total:3,limit:30,offset:0}});
  if(url.pathname === "/meetings") return Response.json({data:[],pagination:{total:0,offset:0}});
  return Response.json({error:"No frame imagery exists for this text-only fixture."},{status:404});
}});
try {
  for(stageIndex=0;stageIndex<tasks.length;stageIndex++) {
    const task = tasks[stageIndex], cwd = join(directory,task);
    await mkdir(cwd);
    await writeFile(join(cwd,".screenpipe-permissions.json"),JSON.stringify({pipe_token:"fictional-pipeline",api_base:`http://127.0.0.1:${server.port}`}));
    const prompt = (await Bun.file(join(assets,`pipes/${task}/pipe.md`)).text()).replace(/^---[\s\S]*?---\s*/,"");
    const child = Bun.spawn([process.execPath,join(homedir(),".screenpipe/pi-agent/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),"--provider","screenpipe","--model","auto","--mode","json","--no-session","--no-extensions","--no-skills","--no-context-files","--no-prompt-templates","--extension",join(assets,"extensions/workflow-memory.ts"),"--extension",join(assets,"extensions/workflow-catalog.ts"),"--print",prompt],{cwd,env:{...process.env,SCREENPIPE_PIPE_NAME:task,PI_CODING_AGENT_DIR:join(homedir(),".screenpipe/pi-config")},stdout:"pipe",stderr:"pipe"});
    const timeout = setTimeout(()=>child.kill(),180000);
    const [stdout,stderr,exit] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);clearTimeout(timeout);
    const saved = stageIndex < 4 ? outputs[stageIndex] : final;
    console.log(JSON.stringify({task,exit,saved:!!saved,items:stageIndex<4?saved?.items.length:final?.workflows.length, classifications:stageIndex===0?saved?.items.map((i:any)=>i.classification):undefined}));
    if(exit !== 0 || !saved) throw new Error(`${task} failed: ${stderr.slice(-1000)} ${stdout.slice(-3000)}`);
  }
  if(!outputs[0].items.some((item:any)=>item.classification === "personal")) throw new Error("Personal work was not classified separately");
  if(!final.workflows.length || JSON.stringify(final.workflows).toLowerCase().includes("birthday")) throw new Error("Expected supported professional workflow without personal shopping");
  console.log(JSON.stringify({passed:true,stages:outputs.length+1,workflows:final.workflows.length}));
} finally {server.stop(true);await rm(directory,{recursive:true,force:true});}
