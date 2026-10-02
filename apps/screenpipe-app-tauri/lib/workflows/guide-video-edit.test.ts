// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
const run=vi.hoisted(()=>vi.fn());
const adopt=vi.hoisted(()=>vi.fn());
vi.mock("./guide-video",()=>({adoptAgentVideo:adopt}));
const stage=vi.hoisted(()=>vi.fn());
vi.mock("./video-project",()=>({stageVideoProject:stage}));
vi.mock("./agent-runner",()=>({runWorkflowAgent:run}));
vi.mock("./assistant",()=>({assistantProviderConfig:{provider:"screenpipe-cloud",model:"auto"}}));
import { editGuideVideo } from "./guide-video-edit";
import videoTool, { applyVideoEdit } from "../../../../packages/workflows-ui/src/video-tool";
const draft={version:1 as const,sourceHash:"abc",scenes:[{id:"section-0",title:"Start",narration:"Read all sources carefully.",includeImage:false}]};
let path: string;
beforeEach(async()=>{vi.clearAllMocks();path=await mkdtemp(`${tmpdir()}/video-tool-test-`);await writeFile(`${path}/video-project.json`,JSON.stringify({draft,images:{}}));stage.mockResolvedValue({path,dispose:vi.fn().mockResolvedValue(undefined)});});
afterEach(async()=>rm(path,{recursive:true,force:true}));
it("uses the scoped tool and sends a single text-only draft with bounded history",async()=>{
 const tools:any={};videoTool({registerTool:(t:any)=>tools[t.name]=t});
 await tools.read_video_sop.execute("read",{},undefined,undefined,{cwd:path,model:{input:["text","image"]}});
 const tool=tools.edit_video_sop;
 run.mockImplementation(async({onEvent})=>{onEvent({type:"tool_execution_end",toolName:"edit_video_sop",result:await tool.execute("1",{changes:[{id:"section-0",narration:"Read sources."}],render:false})});return "Updated";});
 const history=Array.from({length:20},()=>({id:"id",role:"user" as const,text:"x".repeat(2000),at:"now",context:{key:"private",title:"secret catalog"}}));
 const output=await editGuideVideo(draft,"Shorten it",history,new AbortController().signal,()=>{});
 expect(output.changed).toBe(true);expect(output.render).toBe(false);expect(output.draft.scenes[0].narration).toBe("Read sources.");
 const request=run.mock.calls[0][0];expect(request.config.allowedTools).toEqual(["read_video_sop", "edit_video_sop", "render_video_sop"]);
 expect(request.prompt).not.toContain("secret catalog");expect(request.prompt.length).toBeLessThan(12000);
});
it("rejects multiple patches and cancelled turns",async()=>{
 const event={type:"tool_execution_end",toolName:"edit_video_sop",result:{content:[{text:JSON.stringify({changes:[],render:true})}]}};
 run.mockImplementation(async({onEvent})=>{onEvent(event);onEvent(event);return "";});
 await expect(editGuideVideo(draft,"Render",[],new AbortController().signal,()=>{})).rejects.toThrow(/one combined/);
 const abort=new AbortController();run.mockImplementation(async()=>{abort.abort();return "";});
 await expect(editGuideVideo(draft,"Render",[],abort.signal,()=>{})).rejects.toThrow();
});

it("requires project and screenshot inspection before accepting focus edits",async()=>{
 const tools:any={};videoTool({registerTool:(t:any)=>tools[t.name]=t});
 const patch={changes:[{id:"section-0",includeImage:true,focus:{x:0.3,y:0.5,zoom:1.4},pace:1.1}],render:false};
 await expect(tools.edit_video_sop.execute("edit",patch)).rejects.toThrow(/Read/);
 await tools.read_video_sop.execute("read",{},undefined,undefined,{cwd:path,model:{input:["text","image"]}});
 await expect(tools.edit_video_sop.execute("edit",patch)).rejects.toThrow(/Inspect/);
 await writeFile(`${path}/video-project.json`,JSON.stringify({draft,images:{"section-0":"image/png"}}));
 await writeFile(`${path}/section-0.image`,Buffer.from("fixture image"));
 const read=await tools.read_video_sop.execute("image",{scene_id:"section-0"},undefined,undefined,{cwd:path,model:{input:["text","image"]}});
 expect(read.content[0].type).toBe("image");
 expect((await tools.edit_video_sop.execute("edit",patch)).content[0].text).toContain('"pace":1.1');
 await expect(tools.read_video_sop.execute("bad",{scene_id:"../../secret"},undefined,undefined,{cwd:path})).rejects.toThrow(/Unknown/);
});

it("clears focus when explicitly removing an image",()=>{
 const original={...draft,scenes:[{...draft.scenes[0],includeImage:true,focus:{x:0.5,y:0.5,zoom:1.2}}]};
 expect(applyVideoEdit(original,{changes:[{id:"section-0",includeImage:false}],render:false}).scenes[0].focus).toBeNull();
});

it("does not send screenshots to a text-only model or claim that it inspected them",async()=>{
 const tools:any={};videoTool({registerTool:(t:any)=>tools[t.name]=t});
 await writeFile(`${path}/video-project.json`,JSON.stringify({draft,images:{"section-0":"image/png"}}));
 const result=await tools.read_video_sop.execute("image",{scene_id:"section-0"},undefined,undefined,{cwd:path,model:{input:["text"]}});
 expect(result.content[0].type).toBe("text");expect(result.content[0].text).toContain("cannot inspect");
 await expect(tools.edit_video_sop.execute("edit",{changes:[{id:"section-0",focus:{x:0.5,y:0.5,zoom:1.2}}],render:false})).rejects.toThrow(/Inspect/);
});

it("loads bundled guidance on demand without treating it as an inspected project",async()=>{
 const skill=await readFile("../../packages/workflows-ui/skills/video-sop/SKILL.md","utf8");
 await mkdir(`${path}/.pi/skills/video-sop`,{recursive:true});await writeFile(`${path}/.pi/skills/video-sop/SKILL.md`,skill);
 const tools:any={};videoTool({registerTool:(t:any)=>tools[t.name]=t});
 const result=await tools.read_video_sop.execute("guide",{guidance:true},undefined,undefined,{cwd:path});
 expect(result.content[0].text).toBe(skill);
 await expect(tools.edit_video_sop.execute("edit",{changes:[],render:true})).rejects.toThrow(/Read/);
});


it("forwards streamed model text and tool progress to the existing chat", async () => {
 const progress = vi.fn();
 run.mockImplementation(async ({onProgress, onEvent}) => {
  onProgress({text:"I will use the saved screenshots.",toolCalls:[{id:"r",name:"read_video_sop",status:"running"}]});
  onEvent({type:"tool_execution_start", toolName:"read_video_sop"});
  onProgress({text:"The video will follow the three saved steps."});
  return "Ready";
 });
 await editGuideVideo(draft,"Create video",[],new AbortController().signal,progress);
 expect(progress.mock.calls.map(([text]) => text)).toEqual([
  {text:"I will use the saved screenshots.",toolCalls:[{id:"r",name:"read_video_sop",status:"running"}]}, {text:"The video will follow the three saved steps."}
 ]);
});

it("adopts only a completed tool render and never asks the page to render again", async () => {
 const result = {path:"/saved/video.mp4",url:"asset://video.mp4",captionsPath:"/saved/captions.vtt"};
 adopt.mockResolvedValue(result);
 run.mockImplementation(async ({onEvent}) => { onEvent({type:"tool_execution_end",toolName:"render_video_sop",isError:false}); return "Video ready on the page."; });
 const response = await editGuideVideo(draft,"Create video",[],new AbortController().signal,()=>{});
 expect(adopt).toHaveBeenCalledTimes(1);expect(response.result).toBe(result);expect(response.render).toBe(false);
 run.mockImplementation(async ({onEvent}) => { onEvent({type:"tool_execution_end",toolName:"render_video_sop",isError:true}); return "Speech failed."; });
 expect((await editGuideVideo(draft,"Create video",[],new AbortController().signal,()=>{})).result).toBeUndefined();
 expect(adopt).toHaveBeenCalledTimes(1);
});
