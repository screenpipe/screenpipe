// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {mkdtemp, writeFile, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import videoTool from "../../../../packages/workflows-ui/src/video-tool";
let path: string, tools: Record<string, any>;
const draft = {version:1,sourceHash:"abc",scenes:[{id:"section-0",title:"Read",narration:"Read the source.",includeImage:false}]};
beforeEach(async () => {
 path = await mkdtemp(`${tmpdir()}/video-cli-tool-`);tools={};videoTool({registerTool:(tool:any)=>tools[tool.name]=tool});
 await writeFile(`${path}/video-project.json`,JSON.stringify({draft,images:{}}));
 vi.stubEnv("SCREENPIPE_VIDEO_CLI",`${path}/renderer`);
});
afterEach(async () => {vi.unstubAllEnvs();await rm(path,{recursive:true,force:true});});
async function renderer(body: string) {await writeFile(`${path}/renderer`, `#!/usr/bin/env node\n${body}`,{mode:0o700});}
async function read() {await tools.read_video_sop.execute("read",{},undefined,undefined,{cwd:path});}
function render(signal = new AbortController().signal, progress = vi.fn()) {return tools.render_video_sop.execute("render",{},signal,progress,{cwd:path});}
it("awaits the actual subprocess, streams progress and verifies artifacts",async()=>{
 await renderer(`const fs=require('fs');const root=process.argv[3];console.log(JSON.stringify({progress:'Narrating 1 of 2'}));setTimeout(()=>{fs.mkdirSync(root+'/rendered');fs.writeFileSync(root+'/rendered/video.mp4','fixture');fs.writeFileSync(root+'/rendered/captions.vtt','WEBVTT');console.log(JSON.stringify({complete:true}));},30);`);
 await read();await tools.edit_video_sop.execute("edit",{changes:[{id:"section-0",narration:"Updated narration."}],render:false});
 const progress=vi.fn();const result=await render(undefined,progress);
 expect(progress).toHaveBeenCalledWith({content:[{type:"text",text:"Narrating 1 of 2"}]});
 expect(JSON.parse(result.content[0].text).status).toBe("ready");
 expect(JSON.parse(await readFile(`${path}/render-scenes.json`,"utf8"))[0].narration).toBe("Updated narration.");
 await expect(render()).rejects.toThrow(/already attempted/);
 await expect(tools.edit_video_sop.execute("edit",{changes:[],render:false})).rejects.toThrow(/already been created/);
});
it("requires a project and screenshots before launching or spending",async()=>{
 await expect(render()).rejects.toThrow(/Read the attached/);
 await writeFile(`${path}/video-project.json`,JSON.stringify({draft,images:{},requiredImages:["section-0"]}));
 await read();await expect(render()).rejects.toThrow(/screenshot.*unavailable/);
});
it("returns renderer errors and prevents automatic repeated speech attempts",async()=>{
 await renderer(`console.log(JSON.stringify({error:'Speech unavailable'}));process.exit(1);`);
 await read();await expect(render()).rejects.toThrow("Speech unavailable");await expect(render()).rejects.toThrow(/already attempted/);
});
it("does not report success for missing artifacts or a missing completion receipt",async()=>{
 await renderer(`console.log(JSON.stringify({complete:true}));`);await read();await expect(render()).rejects.toThrow();
});
it("stop closes stdin so the renderer can cancel its owned subprocesses",async()=>{
 await renderer(`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({error:'Stopped'}));process.exit(1);});console.log(JSON.stringify({progress:'Rendering'}));`);
 await read();const abort=new AbortController();const progress=vi.fn(()=>abort.abort());
 await expect(render(abort.signal,progress)).rejects.toThrow(/stopped/);expect(progress).toHaveBeenCalled();
});

it("repairs a missing screenshot only after inspecting an available source",async()=>{
 const source={...draft.scenes[0],includeImage:true}, missing={...draft.scenes[0],id:"section-1",title:"Continue"};
 await writeFile(`${path}/video-project.json`,JSON.stringify({draft:{...draft,scenes:[source,missing]},images:{"section-0":"image/png"},requiredImages:["section-0","section-1"]}));
 await writeFile(`${path}/section-0.image`,Buffer.from("fixture"));
 await read();
 const plan=await tools.read_video_sop.execute("read",{},undefined,undefined,{cwd:path});
 expect(JSON.parse(plan.content[0].text).missingScreenshots).toEqual(["section-1"]);
 const patch={changes:[{id:"section-1",imageSourceId:"section-0",includeImage:true}],render:false};
 await expect(tools.edit_video_sop.execute("edit",patch)).rejects.toThrow(/Inspect the source/);
 await tools.read_video_sop.execute("inspect",{scene_id:"section-0"},undefined,undefined,{cwd:path,model:{input:["text"]}});
 await expect(tools.edit_video_sop.execute("edit",patch)).rejects.toThrow(/Inspect the source/);
 await tools.read_video_sop.execute("inspect",{scene_id:"section-0"},undefined,undefined,{cwd:path,model:{input:["text","image"]}});
 await tools.edit_video_sop.execute("edit",patch);
 await renderer(`const fs=require('fs'),root=process.argv[3];fs.mkdirSync(root+'/rendered');fs.writeFileSync(root+'/rendered/video.mp4','fixture');fs.writeFileSync(root+'/rendered/captions.vtt','WEBVTT');console.log(JSON.stringify({complete:true}));`);
 await render();
 const scenes=JSON.parse(await readFile(`${path}/render-scenes.json`,"utf8"));
 expect(scenes).toHaveLength(2);expect(scenes[1].image).toBe(scenes[0].image);expect(scenes[1].narration).toBe(missing.narration);
});
