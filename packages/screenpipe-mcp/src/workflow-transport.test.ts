// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import path from "node:path";

it("discovers and retrieves workflow targeting context through the built MCP transport", async () => {
  const root=path.resolve(__dirname,"..");
  execFileSync("bun",["run","build"],{cwd:root,stdio:"pipe",timeout:120000});
  const id=`wf-${"b".repeat(64)}`;
  const uuidId="wf-12345678-1234-4234-8234-123456789abc";
  const requests: string[]=[];
  const api=createServer((req,res)=>{
    requests.push(req.url || "");
    if(req.headers.authorization !== "Bearer fixture-key") {res.writeHead(403);res.end();return;}
    res.setHeader("Content-Type","application/json");
    if(req.url?.startsWith("/workflows?")) res.end(JSON.stringify({data:[{id,title:"Invoice review"},{id:uuidId,title:"Maintained workflow"}]}));
    else if(req.url?.startsWith(`/workflows/${id}?`)) res.end(JSON.stringify({id,workflow:{stages:[{name:"Review"}]},automationEvidence:[{status:"no_captured_frame",actionTarget:"unknown"}]}));
    else if(req.url?.startsWith(`/workflows/${uuidId}?`)) res.end(JSON.stringify({id:uuidId,workflow:{stages:[{name:"Review maintained workflow"}]}}));
    else if(req.url?.startsWith("/search?")) res.end(JSON.stringify({data:[{starred:req.url.includes("starred_only=true"),type:"Input",content:{id:8,event_type:"click",frame_id:7,x:40,y:60,element_role:"AXButton",element_name:"Approve"}}],pagination:{total:1,offset:0,limit:5}}));
    else if(req.url === "/frames/7/context?include_empty=true") res.end(JSON.stringify({frame_id:7,text_source:"accessibility",nodes:[{role:"AXButton",text:"",bounds:{left:0.25,top:0.5,width:0.125,height:0.0625},properties:{automation_id:"approve"}}]}));
    else { res.writeHead(404);res.end("{}"); }
  });
  await new Promise<void>(resolve=>api.listen(0,"127.0.0.1",resolve));
  const address=api.address();
  if(!address || typeof address === "string") throw new Error("No test API address");
  const client=new Client({name:"workflow-contract-test",version:"1.0"});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,"dist/cli.js")],env:{PATH:process.env.PATH || "",SCREENPIPE_LOCAL_API_URL:`http://127.0.0.1:${address.port}`,SCREENPIPE_LOCAL_API_KEY:"fixture-key",SCREENPIPE_DISABLE_TELEMETRY:"1"},stderr:"pipe"});
  try {
    await client.connect(transport);
    const tools=await client.listTools();
    expect(tools.tools.map(t=>t.name)).toEqual(expect.arrayContaining(["list-workflows","get-workflow"]));
    expect(tools.tools.some(t=>t.name === "list-starred-sessions")).toBe(false);
    expect(tools.tools.find(t=>t.name === "search-content")?.inputSchema.properties).toHaveProperty("starred_only");
    const before = requests.length;
    const starred = await client.callTool({name:"search-content",arguments:{starred_only:true,start_time:"2026-10-02T00:00:00Z",end_time:"2026-10-03T00:00:00Z",limit:5}});
    expect(starred.isError).not.toBe(true);
    expect(JSON.stringify(starred)).toContain("[Starred moment]");
    expect(requests.slice(before)).toHaveLength(1);
    expect(requests.at(-1)).toContain("starred_only=true");
    const listed=await client.callTool({name:"list-workflows",arguments:{q:"invoice"}});
    expect(JSON.stringify(listed)).toContain(id);
    const detail=await client.callTool({name:"get-workflow",arguments:{id}});
    expect(detail.isError).not.toBe(true);expect(JSON.stringify(detail)).toContain("no_captured_frame");
    const maintained=await client.callTool({name:"get-workflow",arguments:{id:uuidId,include_automation:false}});
    expect(maintained.isError).not.toBe(true);
    expect(JSON.stringify(maintained)).toContain("Review maintained workflow");
    expect(requests).toContain(`/workflows/${uuidId}?include_automation=false`);
    const frame=await client.callTool({name:"frame-context",arguments:{frame_id:7,purpose:"automation"}});
    expect(frame.isError).not.toBe(true);expect(JSON.stringify(frame)).toContain("automation_id");
    expect(JSON.stringify(frame)).toContain("0.25");
    expect(requests).toContain("/frames/7/context?include_empty=true");
    const input=await client.callTool({name:"search-content",arguments:{content_type:"input",limit:5}});
    expect(input.isError).not.toBe(true);
    expect(JSON.stringify(input)).toContain("[Input]");
    expect(JSON.stringify(input)).toContain("Approve");
    expect(JSON.stringify(input)).toContain("40");
  } finally { await client.close();await transport.close();await new Promise<void>(resolve=>api.close(()=>resolve())); }
},15000);
