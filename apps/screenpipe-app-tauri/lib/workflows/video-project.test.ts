// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ readDir: vi.fn(), stat: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(), writeTextFile: vi.fn(), remove: vi.fn(), load: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => mocks);
vi.mock("@/lib/utils/tauri", () => ({ commands: {getScreenpipeBaseDir: async () => ({status:"ok",data:"/private/test"})} }));
vi.mock("./guide-video", () => ({loadVideoScreenshot:mocks.load}));
import { stageVideoProject } from "./video-project";
const draft = {version:1 as const,sourceHash:"abc",scenes:[{id:"section-0",title:"Review",narration:"Read the brief",includeImage:true},{id:"section-1",title:"Check",narration:"Check the result",includeImage:true}]};
const scene = {id:"section-0",title:"Review",narration:"Read the brief",image:null,imageFrameId:5};
beforeEach(() => { vi.resetAllMocks(); mocks.readDir.mockResolvedValue([]); for (const fn of [mocks.mkdir,mocks.remove,mocks.writeFile,mocks.writeTextFile]) fn.mockResolvedValue(undefined); mocks.load.mockResolvedValue("data:image/png;base64,aW1hZ2U="); });
it("stages only attached scenes, deduplicates capture loading and disposes only its own directory", async () => {
 const project = await stageVideoProject(draft,[scene,{...scene,id:"section-1"},{...scene,id:"../../secret"}],new AbortController().signal);
 expect(mocks.load).toHaveBeenCalledOnce(); expect(mocks.writeFile).toHaveBeenCalledTimes(2);
 const manifest=JSON.parse(mocks.writeTextFile.mock.calls[0][1]);expect(manifest.images).toEqual({"section-0":"image/png","section-1":"image/png"});
 expect(project.path).toMatch(/^\/private\/test\/pi-workflows-guide\/video-projects\/[a-f0-9-]+$/);
 await project.dispose();expect(mocks.remove).toHaveBeenCalledWith(project.path,{recursive:true});
});
it("keeps wording edits possible when the original screenshot has expired", async () => {
 mocks.load.mockRejectedValue(new Error("unavailable"));
 const project=await stageVideoProject(draft,[scene],new AbortController().signal);
 expect(JSON.parse(mocks.writeTextFile.mock.calls[0][1]).images).toEqual({});await project.dispose();
});
it("cleans up incomplete projects on cancellation and file failures", async () => {
 const abort=new AbortController();mocks.load.mockImplementation(async()=>{abort.abort();throw new DOMException("Stopped","AbortError");});
 await expect(stageVideoProject(draft,[scene],abort.signal)).rejects.toThrow();expect(mocks.remove).toHaveBeenCalledOnce();expect(mocks.writeTextFile).not.toHaveBeenCalled();
 mocks.load.mockResolvedValue("data:image/png;base64,aW1hZ2U=");mocks.writeFile.mockRejectedValue(new Error("Disk full"));
 await expect(stageVideoProject(draft,[scene],new AbortController().signal)).rejects.toThrow(/Disk full/);expect(mocks.remove).toHaveBeenCalledTimes(2);
});

it("prunes only old owned folders and preserves recent turns and unrelated entries", async () => {
 const old="00000000-0000-4000-8000-000000000001", recent="00000000-0000-4000-8000-000000000002";
 mocks.readDir.mockResolvedValue([{name:old,isDirectory:true},{name:recent,isDirectory:true},{name:"other-project",isDirectory:true},{name:"00000000-0000-4000-8000-000000000003",isDirectory:true,isSymlink:true}]);
 mocks.stat.mockImplementation(async (path:string) => ({mtime:new Date(Date.now()-(path.endsWith(old)?172800000:0))}));
 const project=await stageVideoProject(draft,[],new AbortController().signal);
 expect(mocks.stat).toHaveBeenCalledTimes(2);expect(mocks.remove).toHaveBeenCalledOnce();expect(mocks.remove.mock.calls[0][0]).toContain(old);await project.dispose();
});

it("retains a reused original by source ID after reopening even when the donor section was removed",async()=>{
 const next={...draft,scenes:[{...draft.scenes[1],imageSourceId:"section-0"}]};
 const project=await stageVideoProject(next,[{...scene,id:"section-1",imageSourceId:"section-0",requiresImage:true}],new AbortController().signal);
 expect(mocks.writeFile.mock.calls[0][0]).toMatch(/\/section-0\.image$/);
 const manifest=JSON.parse(mocks.writeTextFile.mock.calls[0][1]);
 expect(manifest.images).toEqual({"section-0":"image/png"});expect(manifest.requiredImages).toEqual(["section-1"]);
 await project.dispose();
});
